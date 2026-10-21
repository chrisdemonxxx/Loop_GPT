"""The task agent's think → act → observe loop (Doc 04 §3).

One task agent runs one node of the task DAG until its verification passes or a
budget limit trips. Three properties matter more than cleverness here:

* **Bounded.** Every axis of the budget is enforced before each iteration (I12).
  A loop that retries the same failing approach forever is the most expensive
  bug in the system.
* **Reflective.** A failed verification is not an error to swallow, it is the
  *next input*. "Button X threw 500" becomes the next thing the agent reasons
  about. This reflection loop is what turns a plausible-looking app into a
  working one (Doc 04 §8).
* **Audited.** Every model call and tool call emits an audit record with cost,
  so the run is replayable and cost-per-successful-deploy is computable (I10).

The loop runs in the control plane and executes nothing itself: tool handlers
issue instructions to a leased sandbox (I1).
"""

from __future__ import annotations

import json
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any

from .audit import AuditEvent, AuditSink
from .budget import Budget, BudgetExceeded, BudgetLedger
from .context import (
    DEFAULT_CONDENSE_AT,
    DEFAULT_HEAD_TURNS,
    DEFAULT_TAIL_TURNS,
    Condenser,
    ContextWindow,
    ModelBackedCondenser,
    StablePrefix,
)
from .model import Difficulty, Message, ModelClient, ModelResponse
from .observation import Observation
from .reflection import DEFAULT_REPEAT_LIMIT, FailureTracker, VerificationVerdict, stall_message
from .tools import READ_ONLY_TOOLS, ToolCall, ToolExecutor, ToolRejected, validate_tool_call

#: How many times a reply cut short by the output budget is worth retrying.
#: Two, because the first correction tells the agent something it did not know
#: and the second confirms it cannot act on it.
TRUNCATION_RETRIES = 2

#: Fed back as a tool observation, so it lands where the agent already reads
#: its own consequences rather than as a new kind of message it has never seen.
TRUNCATED_OBSERVATION = (
    "Your reply was cut off because it ran past the output token budget, so no "
    "tool call was received. Answer again, shorter: emit one tool call and keep "
    "any patch small. Split large files across several turns."
)

#: How many consecutive read-only calls are worth spending before saying so.
#: Reading is how an agent orients, so a few in a row is the loop working. A
#: long unbroken run of them is an agent circling a file it has already read.
ORIENTATION_NUDGE_AFTER = 4

#: Where orientation stops being cheap. Past this the run ends, because the
#: alternative is spending the entire iteration budget re-reading and finishing
#: with nothing written — an outcome indistinguishable, to whoever is waiting,
#: from the product not working.
ORIENTATION_LIMIT = 8

ORIENTING_OBSERVATION = (
    "You have made several read-only calls in a row without changing anything. "
    "You have enough to start. Emit an apply_patch now, for the smallest useful "
    "change; you can read again afterwards."
)

REPEATED_OBSERVATION = (
    "You already made this exact call and nothing has changed since, so the "
    "result is identical. Re-reading will not tell you anything new. Use what "
    "you have and emit an apply_patch."
)

#: Consecutive identical FAILING calls. The FailureTracker covers repeated
#: identical verification verdicts; this covers the other half — a model
#: repeating one failing tool call verbatim (the pomodoro run of 2026-10-11
#: burned its whole budget on thirteen copies of one malformed patch). Two
#: earns a pointed observation; three ends the run, because a deterministic
#: executor will not change its answer the third time.
REPEATED_FAILURE_WARN = 2
REPEATED_FAILURE_LIMIT = 3

REPEATED_FAILURE_OBSERVATION = (
    "You already ran this exact call and it failed the same way. Repeating "
    "it cannot produce a different result. Do something DIFFERENT: re-read "
    "the file, split the change into a smaller patch, or take another "
    "approach entirely."
)


class LoopOutcome(StrEnum):
    """Why the loop stopped."""

    #: The task's verification passed.
    VERIFIED = "verified"
    #: A budget axis was exhausted. Surface an explicit status and ask a human.
    BUDGET_EXCEEDED = "budget_exceeded"
    #: A destructive action is waiting on a human confirmation gate (I7).
    AWAITING_GATE = "awaiting_gate"
    #: The agent gave up or produced no actionable call. Re-plan.
    STALLED = "stalled"
    #: The operator cancelled the run. Stop cleanly at the next iteration boundary.
    CANCELLED = "cancelled"


@dataclass(slots=True)
class LoopResult:
    """The outcome of one task agent run."""

    outcome: LoopOutcome
    iterations: int
    summary: str
    transcript: list[Message] = field(default_factory=list)
    usage: dict[str, float | int] = field(default_factory=dict)

    @property
    def succeeded(self) -> bool:
        return self.outcome is LoopOutcome.VERIFIED


#: Called after each tool result. This is where the layered verification
#: pipeline (typecheck → tests → browser → SAST) plugs in.
#:
#: Return a :class:`VerificationVerdict` to report both success and failure: a
#: red verdict's ``observation`` becomes the loop's next input, which is the
#: reflection mechanism (Doc 04 §8). Returning a plain string means verified,
#: and ``None`` means "nothing to report yet".
VerificationHook = Callable[[ToolCall, Observation], "VerificationVerdict | str | None"]


class AgentLoop:
    """Runs one task node to completion or to a bounded stop.

    Args:
        model: the router-backed model client.
        executor: dispatches validated tool calls into the data plane.
        audit: append-only audit sink.
        tenant_id / project_id / run_id / task_id: identity for audit records.
        budget: hard limits for this task.
        verify: hook that reports when the task's verification is green.
        difficulty: routing hint for the router (Doc 03 §2).
        context_max_tokens: usable context window for prompt assembly.
        context_condenser: optional deterministic or specialised summariser.
            When omitted, the loop uses the router at ``trivial`` difficulty so
            long runs keep a memory of failed approaches instead of merely
            dropping the middle of the transcript.
    """

    def __init__(
        self,
        *,
        model: ModelClient,
        executor: ToolExecutor,
        audit: AuditSink,
        tenant_id: str,
        project_id: str,
        run_id: str,
        task_id: str,
        budget: Budget | None = None,
        verify: VerificationHook | None = None,
        difficulty: Difficulty = "implementation",
        repeat_limit: int = DEFAULT_REPEAT_LIMIT,
        context_max_tokens: int = 131_072,
        context_condense_at: float = DEFAULT_CONDENSE_AT,
        context_head_turns: int = DEFAULT_HEAD_TURNS,
        context_tail_turns: int = DEFAULT_TAIL_TURNS,
        context_condenser: Condenser | None = None,
        steer_hook: Callable[[], str | None] | None = None,
        cancel_hook: Callable[[], bool] | None = None,
        assistant_hook: Callable[[str], None] | None = None,
        token_hook: Callable[[str], None] | None = None,
    ) -> None:
        self._model = model
        self._executor = executor
        self._audit = audit
        self._tenant_id = tenant_id
        self._project_id = project_id
        self._run_id = run_id
        self._task_id = task_id
        self._ledger = BudgetLedger(budget or Budget())
        self._verify = verify
        self._difficulty = difficulty
        self._failures = FailureTracker(repeat_limit)
        self._context_max_tokens = context_max_tokens
        self._context_condense_at = context_condense_at
        self._context_head_turns = context_head_turns
        self._context_tail_turns = context_tail_turns
        self._context_condenser = context_condenser
        self._condensation_degradations = 0
        self._steer_hook = steer_hook
        self._cancel_hook = cancel_hook
        self._assistant_hook = assistant_hook
        self._token_hook = token_hook

    def run(self, system_prompt: str, task_goal: str) -> LoopResult:
        """Drive the loop until verified, gated, stalled, or out of budget.

        ``system_prompt`` must be byte-stable across calls and placed first:
        retrieved code and observations go *after* it, so the router's prefix
        cache keeps hitting (Doc 04 §4).
        """
        context = ContextWindow(
            prefix=StablePrefix(system_prompt),
            max_tokens=self._context_max_tokens,
            condense_at=self._context_condense_at,
            head_turns=self._context_head_turns,
            tail_turns=self._context_tail_turns,
            condenser=self._context_condenser or self._model_backed_condenser(),
        )
        context.append(Message("user", task_goal))
        self._emit("task.started", outcome="pending", detail={"goal": task_goal})

        truncations = 0
        orienting = 0
        seen_orienting: set[str] = set()
        failed_signature: str | None = None
        failed_streak = 0

        def register_call_failure(tool: str, args: Any, iteration: int) -> bool:
            """Track consecutive identical failing calls. Returns True at the
            hard limit — the caller stalls the run there. At the warn count
            the model gets a pointed observation instead."""
            nonlocal failed_signature, failed_streak
            try:
                signature = f"{tool}:{json.dumps(args, sort_keys=True, default=str)}"
            except (TypeError, ValueError):
                signature = f"{tool}:{args!r}"
            if signature == failed_signature:
                failed_streak += 1
            else:
                failed_signature, failed_streak = signature, 1
            if failed_streak >= REPEATED_FAILURE_LIMIT:
                self._emit(
                    "agent.repeating_failure",
                    outcome="failure",
                    detail={"iteration": iteration, "tool": tool, "streak": failed_streak},
                )
                return True
            if failed_streak == REPEATED_FAILURE_WARN:
                self._emit(
                    "agent.repeating_failure",
                    outcome="failure",
                    detail={"iteration": iteration, "tool": tool, "streak": failed_streak},
                )
                context.append(Message("tool", REPEATED_FAILURE_OBSERVATION))
            return False

        while True:
            if self._cancel_hook is not None and self._cancel_hook():
                return self._stop(
                    LoopOutcome.CANCELLED,
                    "stopped: cancelled by operator",
                    _full_transcript(context),
                )

            steer = None
            if self._steer_hook is not None:
                steer = self._steer_hook()
            if steer:
                context.append(Message("user", steer))
                self._emit(
                    "task.steered",
                    outcome="success",
                    detail={"iteration": self._ledger.iterations + 1, "message": steer},
                )

            try:
                iteration = self._ledger.start_iteration()
            except BudgetExceeded as exc:
                return self._stop(
                    LoopOutcome.BUDGET_EXCEEDED,
                    f"stopped: {exc}",
                    _full_transcript(context),
                    detail={"axis": exc.axis, "limit": exc.limit, "used": exc.used},
                )

            try:
                prompt = context.build()
                self._ledger.check()
            except BudgetExceeded as exc:
                return self._stop(
                    LoopOutcome.BUDGET_EXCEEDED,
                    f"stopped: {exc}",
                    _full_transcript(context),
                    detail={"axis": exc.axis, "limit": exc.limit, "used": exc.used},
                )

            response = self._model.complete(
                prompt,
                difficulty=self._difficulty,
                response_schema=None,
                on_token=self._token_hook,
            )
            self._ledger.charge(tokens=response.total_tokens, credits=response.credits)
            self._emit(
                "model.called",
                outcome="success",
                cost=response.cost_payload(),
                detail={"iteration": iteration, "finish_reason": response.finish_reason},
            )
            if self._assistant_hook is not None and response.content:
                # The operator's chat pane mirrors what the model actually
                # wrote each turn, not a narration invented afterwards.
                self._assistant_hook(response.content)
            context.append(Message("assistant", response.content))

            raw_call = response.tool_call
            if raw_call is None:
                # A reply that stopped because it ran out of output budget is a
                # different thing from an agent with nothing to say, and only
                # one of the two is recoverable. Ending the run here would blame
                # the agent for a limit it was never told about, so say what
                # happened and let it answer more briefly. Bounded, because an
                # agent that cannot be brief will otherwise spend the whole
                # budget discovering that.
                if response.finish_reason == "length" and truncations < TRUNCATION_RETRIES:
                    truncations += 1
                    self._emit(
                        "model.truncated",
                        outcome="failure",
                        detail={"iteration": iteration, "attempt": truncations},
                    )
                    context.append(Message("tool", TRUNCATED_OBSERVATION))
                    continue
                return self._stop(
                    LoopOutcome.STALLED,
                    (
                        "stopped: the agent's reply was cut off by the output "
                        "budget before it produced a tool call"
                        if response.finish_reason == "length"
                        else "stopped: the agent produced no tool call"
                    ),
                    _full_transcript(context),
                    detail={"finish_reason": response.finish_reason},
                )

            try:
                call = validate_tool_call(raw_call)
            except ToolRejected as rejection:
                self._emit(
                    "tool.rejected",
                    outcome="denied",
                    detail={"iteration": iteration, "error": rejection.message},
                )
                context.append(Message("tool", rejection.observation))
                if register_call_failure(
                    str(raw_call.get("tool") or "?"), raw_call.get("args"), iteration
                ):
                    return self._stop(
                        LoopOutcome.STALLED,
                        (
                            f"stopped: the same failing call was made "
                            f"{REPEATED_FAILURE_LIMIT} times in a row"
                        ),
                        _full_transcript(context),
                        detail={"reason": "repeated_call_failure"},
                    )
                continue

            if self._executor.requires_gate(call):
                self._emit(
                    "gate.requested",
                    outcome="pending",
                    detail={
                        "tool": call.tool,
                        "call_id": call.call_id,
                        "gate_id": self._executor.gate_id(call),
                        "args_hash": self._executor.approval_binding(call),
                        "args": dict(call.args),
                    },
                )
                return self._stop(
                    LoopOutcome.AWAITING_GATE,
                    f"paused: {call.tool!r} requires human confirmation",
                    _full_transcript(context),
                )

            try:
                result = self._executor.execute(call)
            except ToolRejected as rejection:
                self._emit(
                    "tool.rejected",
                    outcome="denied",
                    detail={"iteration": iteration, "tool": call.tool, "error": rejection.message},
                )
                context.append(Message("tool", rejection.observation))
                if register_call_failure(call.tool, dict(call.args), iteration):
                    return self._stop(
                        LoopOutcome.STALLED,
                        (
                            f"stopped: the same failing call was made "
                            f"{REPEATED_FAILURE_LIMIT} times in a row"
                        ),
                        _full_transcript(context),
                        detail={"reason": "repeated_call_failure"},
                    )
                continue

            observation = result.as_observation(call.tool)
            self._emit(
                "tool.called",
                outcome="success" if result.ok else "failure",
                detail={
                    "iteration": iteration,
                    "tool": call.tool,
                    "args": dict(call.args),
                    **dict(result.detail),
                },
            )
            # Tool output enters the prompt as fenced, labelled data — never as
            # instructions (Doc 02 §8).
            context.append(Message("tool", observation.for_prompt()))

            if result.ok:
                # The iteration budget prices recovery, not work: this turn
                # executed, so it does not spend the budget meant to stop a
                # run that is getting nowhere. A red verdict from the verify
                # hook below is still progress — it is the reflection input
                # for the next turn — and genuinely stuck loops end on the
                # stall detector (repeated identical failures), the orbit
                # guard (consecutive reads) or the truncation retry limit,
                # none of which need the budget to do their job.
                self._ledger.refund_iteration()
                failed_signature = None
                failed_streak = 0
            elif register_call_failure(call.tool, dict(call.args), iteration):
                # The same call with the same args met the same deterministic
                # executor: the third copy will not get a different answer.
                return self._stop(
                    LoopOutcome.STALLED,
                    (
                        f"stopped: the same failing call was made "
                        f"{REPEATED_FAILURE_LIMIT} times in a row"
                    ),
                    _full_transcript(context),
                    detail={"reason": "repeated_call_failure"},
                )

            if call.tool in READ_ONLY_TOOLS:
                orienting += 1
                signature = f"{call.tool}:{json.dumps(dict(call.args), sort_keys=True)}"
                repeated = signature in seen_orienting
                seen_orienting.add(signature)
                if orienting >= ORIENTATION_LIMIT:
                    self._emit(
                        "agent.orbiting",
                        outcome="failure",
                        detail={"iteration": iteration, "reads": orienting},
                    )
                    return self._stop(
                        LoopOutcome.STALLED,
                        (
                            f"stopped: the agent made {orienting} read-only calls in a "
                            "row without changing anything"
                        ),
                        _full_transcript(context),
                        detail={"reads": orienting},
                    )
                if repeated or orienting == ORIENTATION_NUDGE_AFTER:
                    context.append(
                        Message("tool", REPEATED_OBSERVATION if repeated else ORIENTING_OBSERVATION)
                    )
            else:
                orienting = 0
                seen_orienting.clear()

            if self._verify is not None:
                verdict = _as_verdict(self._verify(call, observation))
                if verdict is None:
                    continue

                if verdict.verified:
                    self._failures.reset()
                    return self._stop(
                        LoopOutcome.VERIFIED,
                        verdict.summary,
                        _full_transcript(context),
                    )

                if verdict.observation is None:
                    continue

                # A failed verification is the next input, not an error to
                # swallow. The text arrives already fenced by the verification
                # adapter, which knows which part is attacker-influenced command
                # output and which part is the platform's own framing.
                stuck = self._failures.record(verdict.observation)
                self._emit(
                    "verification.failed",
                    outcome="failure",
                    detail={
                        "iteration": iteration,
                        "repeat_count": self._failures.repeat_count,
                        "observation": verdict.observation,
                    },
                )
                context.append(Message("tool", verdict.observation))

                if stuck:
                    return self._stop(
                        LoopOutcome.STALLED,
                        stall_message(self._failures.repeat_count),
                        _full_transcript(context),
                        detail={"reason": "repeated_verification_failure"},
                    )

    # -- internals -------------------------------------------------------------

    def _stop(
        self,
        outcome: LoopOutcome,
        summary: str,
        transcript: list[Message],
        detail: dict[str, Any] | None = None,
    ) -> LoopResult:
        usage = self._ledger.snapshot()
        self._emit(
            "task.completed",
            outcome="success" if outcome is LoopOutcome.VERIFIED else "failure",
            detail={
                "outcome": outcome.value,
                "summary": summary,
                "cancelled": outcome is LoopOutcome.CANCELLED,
                **(detail or {}),
                **usage,
            },
        )
        return LoopResult(
            outcome=outcome,
            iterations=self._ledger.iterations,
            summary=summary,
            transcript=transcript,
            usage=usage,
        )

    def _emit(
        self,
        event_type: str,
        *,
        outcome: str,
        detail: dict[str, Any] | None = None,
        cost: dict[str, Any] | None = None,
    ) -> None:
        self._audit.emit(
            AuditEvent(
                type=event_type,
                tenant_id=self._tenant_id,
                actor_kind="agent",
                actor_id=self._task_id,
                project_id=self._project_id,
                run_id=self._run_id,
                task_id=self._task_id,
                # The loop itself is control-plane; the effects it requests land
                # in the data plane.
                plane="data",
                outcome=outcome,  # type: ignore[arg-type]
                cost=cost,
                detail=detail or {},
            )
        )

    def _model_backed_condenser(self) -> Condenser:
        """Use the router for memory-preserving compaction, charged to the task.

        Condensation is not a free side channel. If a long run needs a summary
        to stay alive, that summarisation consumes the same token and credit
        budget as the main loop and emits an audit event with its own cost.
        """

        return ModelBackedCondenser(
            self._model,
            on_response=self._record_condensation,
            on_degraded=self._record_condensation_degradation,
        )

    def _record_condensation(self, response: ModelResponse) -> None:
        self._ledger.charge(tokens=response.total_tokens, credits=response.credits)
        self._emit(
            "context.condensed",
            outcome="success",
            cost=response.cost_payload(),
            detail={"difficulty": "trivial", "finish_reason": response.finish_reason},
        )

    def _record_condensation_degradation(self, exc: Exception) -> None:
        """Audit a lossy fallback without making housekeeping fatal.

        A failed summariser means the next prompt has weaker memory, not that
        the build should die. Counting degraded condensations is enough signal
        for operators to correlate later repetition with an upstream outage
        without adding a second stall policy that fights the budget ledger.
        """

        self._condensation_degradations += 1
        self._emit(
            "context.condensation_degraded",
            outcome="failure",
            detail={
                "count": self._condensation_degradations,
                "difficulty": "trivial",
                "exception_type": type(exc).__name__,
                "error": str(exc),
            },
        )


def format_tool_catalogue(tools: Sequence[str]) -> str:
    """Render the available tools for the stable system prefix."""
    return json.dumps(sorted(tools), separators=(",", ":"))


def _full_transcript(context: ContextWindow) -> list[Message]:
    """Return the audit transcript, not the compacted prompt."""
    return [context.prefix.as_message(), *context.history]


def _as_verdict(value: VerificationVerdict | str | None) -> VerificationVerdict | None:
    """Accept the terse hook forms as well as a full verdict.

    A bare string has always meant "verified, here is the summary". Keeping that
    shape working means the many hooks that only ever report success do not have
    to construct a verdict object in order to say so.
    """
    if value is None:
        return None
    if isinstance(value, str):
        return VerificationVerdict.green(value)
    return value
