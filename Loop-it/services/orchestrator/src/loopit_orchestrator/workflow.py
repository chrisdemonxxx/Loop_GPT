"""Temporal workflow definition for durable Loop-it runs."""

from __future__ import annotations

from datetime import datetime, timedelta

from temporalio import workflow

with workflow.unsafe.imports_passed_through():
    from loopit_agent_core.observation import untrusted

    from .activities import (
        WORKSPACE_DISPATCH_HTTP_TIMEOUT_SECONDS,
        acquire_sandbox_lease,
        emit_audit_event,
        execute_agent_step,
        release_sandbox_lease,
        renew_sandbox_lease,
        run_verification,
    )
    from .decisions import (
        BudgetSnapshot,
        WorkflowBudgetExceeded,
        add_usage,
        default_activity_retry_policy,
        enforce_budget,
    )
    from .failure_text import describe_failure
    from .types import (
        AcquireLeaseInput,
        AgentStepInput,
        ApprovalSignal,
        AuditEventInput,
        GateRequest,
        LeaseInfo,
        ReleaseLeaseInput,
        RenewLeaseInput,
        RunStatus,
        RunWorkflowInput,
        StepOutcome,
        TranscriptMessage,
        VerificationInput,
        WorkflowStatus,
    )

ACTIVITY_RETRY = default_activity_retry_policy()
LEASE_ACTIVITY_TIMEOUT = timedelta(seconds=30)
# Router failover can spend 2 candidates * 3 attempts * 180s upstream timeout.
ROUTER_FAILOVER_TIMEOUT_SECONDS = 2 * 3 * 180
ROUTER_HTTP_HEADROOM_SECONDS = 180
WORKSPACE_DISPATCH_TIMEOUT_SECONDS = WORKSPACE_DISPATCH_HTTP_TIMEOUT_SECONDS
TEMPORAL_STEP_HEADROOM_SECONDS = 60
STEP_ACTIVITY_TIMEOUT = timedelta(
    seconds=ROUTER_FAILOVER_TIMEOUT_SECONDS
    + ROUTER_HTTP_HEADROOM_SECONDS
    + WORKSPACE_DISPATCH_TIMEOUT_SECONDS
    + TEMPORAL_STEP_HEADROOM_SECONDS
)
VERIFY_ACTIVITY_TIMEOUT = timedelta(minutes=20)
CHECKPOINT_ACTIVITY_TIMEOUT = timedelta(minutes=10)
LONG_ACTIVITY_HEARTBEAT_TIMEOUT = timedelta(seconds=30)
GATE_TIMEOUT = timedelta(minutes=30)
MAX_TRANSCRIPT_MESSAGES = 24
MAX_TRANSCRIPT_CHARS = 24_000
MAX_TRANSCRIPT_MESSAGE_CHARS = 4_000


@workflow.defn
class RunWorkflow:
    """Durable run lifecycle: plan, iterate, verify, checkpoint, complete/fail."""

    def __init__(self) -> None:
        self._input: RunWorkflowInput | None = None
        self._status = RunStatus.QUEUED
        self._budget = BudgetSnapshot()
        self._summary = ""
        self._checkpoint_id: str | None = None
        self._gate: GateRequest | None = None
        self._transcript: tuple[TranscriptMessage, ...] = ()
        self._approved_gate_bindings: set[str] = set()
        self._approval: ApprovalSignal | None = None
        self._started_at: datetime = workflow.now()
        self._finished_at: datetime | None = None

    @workflow.run
    async def run(self, payload: RunWorkflowInput) -> WorkflowStatus:
        self._input = payload
        self._started_at = workflow.now()
        self._status = RunStatus.RUNNING
        await self._audit("run.started", "pending", {"prompt": payload.prompt})

        try:
            lease: LeaseInfo | None = None
            try:
                while True:
                    self._check_budget(payload)
                    if lease is None:
                        lease = await self._acquire_lease(payload)
                    else:
                        lease = await self._renew_lease(payload, lease)
                    active_lease = lease
                    step = await workflow.execute_activity(
                        execute_agent_step,
                        AgentStepInput(
                            payload,
                            active_lease,
                            tuple(sorted(self._approved_gate_bindings)),
                            self._summary,
                            self._transcript,
                        ),
                        start_to_close_timeout=STEP_ACTIVITY_TIMEOUT,
                        heartbeat_timeout=LONG_ACTIVITY_HEARTBEAT_TIMEOUT,
                        retry_policy=ACTIVITY_RETRY,
                    )
                    self._budget = add_usage(self._budget, step.usage)
                    self._summary = step.summary
                    if step.transcript_delta:
                        self._transcript = self._append_transcript(step.transcript_delta)
                    if step.consumed_gate_binding is not None:
                        self._approved_gate_bindings.discard(step.consumed_gate_binding)
                    self._check_budget(payload)

                    if step.outcome is StepOutcome.AWAITING_GATE:
                        await self._release_lease(payload, active_lease, "awaiting-approval")
                        lease = None
                        if not await self._await_gate(step.gate):
                            self._status = RunStatus.FAILED
                            self._summary = "approval gate rejected or timed out"
                            break
                        self._status = RunStatus.RUNNING
                        continue

                    if step.outcome is StepOutcome.STALLED:
                        if step.failure_class == "gate-rejected":
                            await self._audit(
                                "gate.approval_mismatch",
                                "denied",
                                {"summary": step.summary},
                            )
                        self._status = RunStatus.FAILED
                        break

                    self._status = RunStatus.VERIFYING
                    verification = await workflow.execute_activity(
                        run_verification,
                        VerificationInput(payload, active_lease, self._summary),
                        start_to_close_timeout=VERIFY_ACTIVITY_TIMEOUT,
                        heartbeat_timeout=LONG_ACTIVITY_HEARTBEAT_TIMEOUT,
                        retry_policy=ACTIVITY_RETRY,
                    )
                    self._budget = add_usage(self._budget, verification.usage)
                    self._summary = verification.summary
                    self._check_budget(payload)
                    if not verification.verified:
                        self._status = RunStatus.RUNNING
                        continue

                    self._status = RunStatus.CHECKPOINTING
                    self._checkpoint_id = verification.checkpoint_id
                    self._status = RunStatus.SUCCEEDED
                    break
            finally:
                if lease is not None:
                    await self._release_lease(payload, lease, "completed")
        except WorkflowBudgetExceeded as exc:
            self._status = RunStatus.FAILED
            self._summary = str(exc)
            await self._audit("run.budget_exceeded", "failure", {"axis": exc.axis})
        except Exception as exc:
            self._status = RunStatus.FAILED
            self._summary = describe_failure(exc)
            await self._audit("run.failed", "failure", {"error": self._summary})
            raise
        finally:
            self._finished_at = workflow.now()
            await self._audit(
                "run.completed",
                "success" if self._status is RunStatus.SUCCEEDED else "failure",
                {"status": self._status.value, "summary": self._summary},
            )
        return self._snapshot()

    @workflow.signal
    async def approve_gate(self, signal: ApprovalSignal) -> None:
        self._approval = signal

    @workflow.query
    def status(self) -> WorkflowStatus:
        return self._snapshot()

    @workflow.query
    def progress(self) -> dict[str, object]:
        return {
            "run_id": self._snapshot().run_id,
            "status": self._status.value,
            "iterations": self._budget.iterations,
            "tokens": self._budget.tokens,
            "credits": str(self._budget.credits),
            "summary": self._summary,
            "gate": self._gate,
        }

    async def _acquire_lease(self, payload: RunWorkflowInput) -> LeaseInfo:
        return await workflow.execute_activity(
            acquire_sandbox_lease,
            AcquireLeaseInput(
                payload.tenant_id,
                payload.run_id,
                payload.project_id,
                payload.base_checkpoint_id,
            ),
            start_to_close_timeout=LEASE_ACTIVITY_TIMEOUT,
            retry_policy=ACTIVITY_RETRY,
        )

    async def _renew_lease(self, payload: RunWorkflowInput, lease: LeaseInfo) -> LeaseInfo:
        return await workflow.execute_activity(
            renew_sandbox_lease,
            RenewLeaseInput(payload.tenant_id, lease.lease_id),
            start_to_close_timeout=LEASE_ACTIVITY_TIMEOUT,
            retry_policy=ACTIVITY_RETRY,
        )

    async def _release_lease(
        self, payload: RunWorkflowInput, lease: LeaseInfo, reason: str
    ) -> None:
        await workflow.execute_activity(
            release_sandbox_lease,
            ReleaseLeaseInput(payload.tenant_id, lease.lease_id, reason),
            start_to_close_timeout=LEASE_ACTIVITY_TIMEOUT,
            retry_policy=ACTIVITY_RETRY,
        )

    def _append_transcript(
        self, delta: tuple[TranscriptMessage, ...]
    ) -> tuple[TranscriptMessage, ...]:
        """Keep recent observations in workflow state without unbounded history.

        Temporal serializes activity inputs and workflow state into history, so a
        full chat log would eventually make long runs unreplayable. The current
        orchestrator-owned services do not expose a durable transcript blob API,
        and changing workspace-dispatch would break the concurrent owner. This
        workflow therefore stores a bounded recent transcript directly: enough
        assistant/tool-observation context to avoid amnesia, while capping the
        history impact by message count and bytes. A future blob/checkpoint
        transcript reference can replace this helper when that store exists.
        """

        compacted = tuple(_compact_message(item) for item in (*self._transcript, *delta))
        kept_reversed: list[TranscriptMessage] = []
        total_chars = 0
        for item in reversed(compacted):
            next_total = total_chars + len(item.content)
            if kept_reversed and (
                len(kept_reversed) >= MAX_TRANSCRIPT_MESSAGES or next_total > MAX_TRANSCRIPT_CHARS
            ):
                break
            kept_reversed.append(item)
            total_chars = next_total
        return tuple(reversed(kept_reversed))

    async def _await_gate(self, gate: GateRequest | None) -> bool:
        if gate is None:
            self._status = RunStatus.FAILED
            self._summary = "agent requested a gate without gate details"
            return False
        self._gate = gate
        self._approval = None
        self._status = RunStatus.AWAITING_APPROVAL
        await self._audit("gate.requested", "pending", {"gate_id": gate.gate_id, "tool": gate.tool})
        gate_timeout = self._gate_timeout(gate)
        if gate_timeout <= timedelta(seconds=0):
            await self._audit(
                "gate.rejected", "denied", {"gate_id": gate.gate_id, "reason": "expired"}
            )
            return False
        try:
            await workflow.wait_condition(
                lambda: self._approval is not None and self._approval.gate_id == gate.gate_id,
                timeout=gate_timeout,
            )
        except TimeoutError:
            await self._audit("gate.rejected", "denied", {"gate_id": gate.gate_id})
            return False
        approval = self._current_approval()
        if approval is None:
            await self._audit("gate.rejected", "denied", {"gate_id": gate.gate_id})
            return False
        if self._gate_timeout(gate) <= timedelta(seconds=0):
            await self._audit(
                "gate.rejected",
                "denied",
                {"gate_id": gate.gate_id, "actor_id": approval.actor_id, "reason": "expired"},
            )
            return False
        self._gate = None
        if not approval.approved:
            await self._audit(
                "gate.rejected",
                "denied",
                {"gate_id": gate.gate_id, "actor_id": approval.actor_id, "reason": approval.reason},
            )
            return False
        self._approved_gate_bindings.add(gate.args_hash)
        await self._audit(
            "gate.approved",
            "success",
            {
                "gate_id": gate.gate_id,
                "args_hash": gate.args_hash,
                "actor_id": approval.actor_id,
                "reason": approval.reason,
            },
        )
        return True

    def _gate_timeout(self, gate: GateRequest) -> timedelta:
        if gate.expires_at is None:
            return GATE_TIMEOUT
        try:
            expires = datetime.fromisoformat(gate.expires_at.replace("Z", "+00:00"))
        except ValueError:
            return timedelta(seconds=0)
        now = workflow.now()
        if expires.tzinfo is None:
            expires = expires.replace(tzinfo=now.tzinfo)
        return min(GATE_TIMEOUT, expires - now)

    def _current_approval(self) -> ApprovalSignal | None:
        return self._approval

    def _check_budget(self, payload: RunWorkflowInput) -> None:
        elapsed = int((workflow.now() - self._started_at).total_seconds())
        enforce_budget(self._budget, payload.budget, elapsed_seconds=elapsed)

    async def _audit(self, event_type: str, outcome: str, detail: dict[str, object]) -> None:
        if self._input is None:
            return
        payload = self._input
        await workflow.execute_activity(
            emit_audit_event,
            AuditEventInput(
                payload.tenant_id,
                payload.project_id,
                payload.run_id,
                event_type,
                outcome,
                dict(detail),
            ),
            start_to_close_timeout=timedelta(seconds=10),
            retry_policy=ACTIVITY_RETRY,
        )

    def _snapshot(self) -> WorkflowStatus:
        if self._input is None:
            return WorkflowStatus("", "", self._status)
        return WorkflowStatus(
            run_id=self._input.run_id,
            project_id=self._input.project_id,
            status=self._status,
            iterations=self._budget.iterations,
            tokens=self._budget.tokens,
            credits=self._budget.credits,
            summary=self._summary,
            checkpoint_id=self._checkpoint_id,
            gate=self._gate,
            started_at=self._started_at,
            finished_at=self._finished_at,
        )


def _compact_message(message: TranscriptMessage) -> TranscriptMessage:
    if len(message.content) <= MAX_TRANSCRIPT_MESSAGE_CHARS:
        return message
    if message.role == "tool":
        wrapper = untrusted("", source="compacted transcript", truncated=True)
        body_limit = max(0, MAX_TRANSCRIPT_MESSAGE_CHARS - len(wrapper))
        return TranscriptMessage(
            "tool",
            untrusted(
                message.content[:body_limit],
                source="compacted transcript",
                truncated=True,
            ),
        )
    omitted = len(message.content) - MAX_TRANSCRIPT_MESSAGE_CHARS
    suffix = f"\n...[truncated {omitted} chars]"
    return TranscriptMessage(
        message.role,
        f"{message.content[: MAX_TRANSCRIPT_MESSAGE_CHARS - len(suffix)]}{suffix}",
    )
