"""The router itself — quota, credential injection, dispatch, attribution.

Order of operations is the security property. Quota is checked before a token is
bought; the credential is resolved after routing and immediately before dispatch
so it exists in memory for the shortest possible window; and the audit record is
emitted on every outcome, including refusals and failures, because a stream with
gaps cannot be used for billing or forensics.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping, Sequence
from contextlib import ExitStack
from dataclasses import replace
from typing import Any

from loopit_agent_core.audit import AuditEvent, AuditSink
from loopit_model_licenses import LicenseRegisterError, ModelLicenseRegister, load_default_register

from .errors import RouterError, TerminalUpstreamError, UpstreamError
from .quota import QuotaExceeded, QuotaLedger
from .routing import (
    Difficulty,
    InMemoryModelSelectionStore,
    ModelSpec,
    RoutingPolicy,
    SelectionScope,
)
from .upstream import SecretResolver, StreamingUpstream, Upstream, UpstreamRequest, UpstreamResult

SERVICE_NAME = "router-svc"

#: Charged when a call fails before we learn the real token count. Failures are
#: not free — a truncated generation still consumed capacity.
_FAILED_CALL_FLOOR_CREDITS = 0.0

__all__ = ["SERVICE_NAME", "ModelRouter", "RouterError", "UpstreamError"]


class ModelRouter:
    """Routes an inference request to a model on behalf of a tenant.

    The sandbox calls this service; it never calls a model provider directly.
    That single choke point is what makes per-tenant cost attribution, quota
    enforcement, and credential isolation all enforceable in one place.
    """

    def __init__(
        self,
        policy: RoutingPolicy,
        upstream: Upstream,
        ledger: QuotaLedger,
        secrets: SecretResolver,
        audit: AuditSink,
        selection_store: InMemoryModelSelectionStore | None = None,
        license_register: ModelLicenseRegister | None = None,
    ) -> None:
        self._policy = policy
        self._upstream = upstream
        self._ledger = ledger
        self._secrets = secrets
        self._audit = audit
        self._selection_store = selection_store
        self._license_register = license_register or load_default_register()

    @property
    def policy(self) -> RoutingPolicy:
        return self._policy

    def complete(
        self,
        *,
        tenant_id: str,
        difficulty: Difficulty,
        messages: Sequence[Mapping[str, Any]],
        response_schema: Mapping[str, Any] | None = None,
        max_output_tokens: int | None = None,
        run_id: str | None = None,
        project_id: str | None = None,
        task_id: str | None = None,
        trace_id: str | None = None,
        estimated_credits: float | None = None,
        on_token: Callable[[str], None] | None = None,
    ) -> UpstreamResult:
        """Run one inference call, or refuse it.

        Raises:
            QuotaExceeded: the tenant cannot afford the call. Nothing was spent.
            UpstreamError: every candidate model failed.
        """
        policy = self._policy
        if self._selection_store is not None:
            policy = self._selection_store.resolve(
                SelectionScope(tenant_id, project_id=project_id), self._policy
            )
        candidates = policy.candidates(difficulty)
        estimate = (
            estimated_credits
            if estimated_credits is not None
            else self._estimate(candidates[0], messages, max_output_tokens)
        )

        # Entered eagerly so a refusal is distinguishable from an upstream fault:
        # the exception surfaces on __enter__, not at the `reserve` call itself.
        stack = ExitStack()
        try:
            reservation = stack.enter_context(self._ledger.reserve(tenant_id, estimate))
        except QuotaExceeded as exceeded:
            self._emit(
                "quota.denied",
                tenant_id=tenant_id,
                run_id=run_id,
                task_id=task_id,
                trace_id=trace_id,
                outcome="denied",
                detail={
                    "difficulty": difficulty,
                    "requested_credits": exceeded.requested,
                    "remaining_credits": exceeded.remaining,
                    "reason": "tenant credit limit reached",
                },
            )
            raise

        failures: list[str] = []
        with stack:
            for spec in candidates:
                try:
                    self._license_register.assert_servable_commercially(spec.name)
                except LicenseRegisterError as error:
                    self._emit(
                        "model.license_denied",
                        tenant_id=tenant_id,
                        run_id=run_id,
                        project_id=project_id,
                        task_id=task_id,
                        trace_id=trace_id,
                        outcome="denied",
                        detail={
                            "model": spec.name,
                            "difficulty": difficulty,
                            "reason": str(error),
                        },
                    )
                    failures.append(f"{spec.name}: LicenseRegisterError: {error}")
                    continue
                request = UpstreamRequest(
                    model=spec.wire_model,
                    messages=messages,
                    # Resolved here, last possible moment, and never returned.
                    api_key=self._secrets.resolve(spec.credential_ref),
                    upstream_base_url=spec.upstream_base_url,
                    response_schema=response_schema,
                    max_output_tokens=max_output_tokens,
                    metadata={"tenant_id": tenant_id, "run_id": run_id},
                )
                try:
                    if on_token is not None and isinstance(self._upstream, StreamingUpstream):
                        result = self._upstream.complete_stream(request, on_token)
                    else:
                        result = self._upstream.complete(request)
                        if on_token is not None and result.content:
                            # Non-streaming backend: the operator still gets the
                            # turn, as one chunk instead of a trickle.
                            on_token(result.content)
                except TerminalUpstreamError as error:
                    # Auth, billing, and malformed requests fail identically on
                    # every candidate. Trying the rest would add latency, spend
                    # nothing useful, and write N audit rows blaming N models for
                    # one account-level fault.
                    self._emit(
                        "model.called",
                        tenant_id=tenant_id,
                        run_id=run_id,
                        task_id=task_id,
                        trace_id=trace_id,
                        outcome="failure",
                        cost={"credits": _FAILED_CALL_FLOOR_CREDITS},
                        detail={
                            "model": spec.name,
                            "backend": spec.backend,
                            "difficulty": difficulty,
                            "error": f"{type(error).__name__}: {error}",
                            "terminal": True,
                            "failover_skipped": len(candidates) - candidates.index(spec) - 1,
                        },
                    )
                    raise
                except Exception as error:
                    failures.append(f"{spec.name}: {type(error).__name__}: {error}")
                    self._emit(
                        "model.called",
                        tenant_id=tenant_id,
                        run_id=run_id,
                        task_id=task_id,
                        trace_id=trace_id,
                        outcome="failure",
                        cost={"credits": _FAILED_CALL_FLOOR_CREDITS},
                        detail={
                            "model": spec.name,
                            "backend": spec.backend,
                            "difficulty": difficulty,
                            "error": f"{type(error).__name__}: {error}",
                        },
                    )
                    continue

                credits = spec.credits_for(
                    result.input_tokens, result.output_tokens, result.cached_input_tokens
                )
                reservation.settle(credits)
                # The transport counts tokens; only the router knows the rate
                # card, so the price is attached here rather than guessed there.
                result = replace(result, credits=credits)
                self._emit(
                    "model.called",
                    tenant_id=tenant_id,
                    run_id=run_id,
                    task_id=task_id,
                    trace_id=trace_id,
                    outcome="success",
                    cost={
                        "credits": credits,
                        "input_tokens": result.input_tokens,
                        "output_tokens": result.output_tokens,
                        "cached_input_tokens": result.cached_input_tokens,
                    },
                    detail={
                        "model": spec.name,
                        "backend": spec.backend,
                        "difficulty": difficulty,
                        "fallback_depth": candidates.index(spec),
                        "structured_output": request.uses_structured_output,
                        "finish_reason": result.finish_reason,
                    },
                )
                return result

        raise UpstreamError(
            f"all {len(candidates)} candidate models failed for difficulty {difficulty!r}",
            failures,
        )

    def _estimate(
        self,
        spec: ModelSpec,
        messages: Sequence[Mapping[str, Any]],
        max_output_tokens: int | None,
    ) -> float:
        """An intentionally pessimistic pre-spend estimate.

        Over-reserving briefly refuses a call a tenant could just afford;
        under-reserving lets them overspend. The former is recoverable.
        """
        characters = sum(len(str(message.get("content", ""))) for message in messages)
        input_tokens = max(1, characters // 3)  # deliberately conservative vs ~4 chars/token
        output_tokens = max_output_tokens if max_output_tokens is not None else 2048
        return spec.credits_for(input_tokens, output_tokens)

    def _emit(self, event_type: str, **kwargs: Any) -> None:
        self._audit.emit(
            AuditEvent(
                type=event_type,
                actor_kind="service",
                actor_service=SERVICE_NAME,
                plane="control",
                **kwargs,
            )
        )
