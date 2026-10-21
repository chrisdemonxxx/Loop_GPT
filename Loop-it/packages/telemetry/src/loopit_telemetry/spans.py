from __future__ import annotations

from collections.abc import Iterator, Mapping
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Any

from opentelemetry import trace
from opentelemetry.trace import Span, Status, StatusCode

from .attributes import scrub_attributes


@dataclass(frozen=True, slots=True)
class CorrelationIds:
    tenant_id: str
    project_id: str
    run_id: str
    task_id: str | None = None

    def attributes(self) -> dict[str, str]:
        values = {
            "loopit.tenant_id": self.tenant_id,
            "loopit.project_id": self.project_id,
            "loopit.run_id": self.run_id,
        }
        if self.task_id is not None:
            values["loopit.task_id"] = self.task_id
        return values


@contextmanager
def span_run(correlation: CorrelationIds, **attributes: Any) -> Iterator[Span]:
    with _span("loopit.run", correlation, attributes) as span:
        yield span


@contextmanager
def span_agent_step(
    correlation: CorrelationIds, *, step: str, iteration: int, **attributes: Any
) -> Iterator[Span]:
    with _span(
        "loopit.agent.step",
        correlation,
        {"loopit.step": step, "loopit.iteration": iteration, **attributes},
    ) as span:
        yield span


@contextmanager
def span_tool_call(
    correlation: CorrelationIds, *, tool: str, call_id: str | None = None, **attributes: Any
) -> Iterator[Span]:
    data: dict[str, Any] = {"loopit.tool": tool, **attributes}
    if call_id is not None:
        data["loopit.tool_call_id"] = call_id
    with _span("loopit.tool.call", correlation, data) as span:
        yield span


@contextmanager
def span_model_call(
    correlation: CorrelationIds,
    *,
    model: str,
    input_tokens: int = 0,
    output_tokens: int = 0,
    cost_usd: float = 0.0,
    cache_hit_fraction: float = 0.0,
    **attributes: Any,
) -> Iterator[Span]:
    with _span(
        "loopit.model.call",
        correlation,
        {
            "gen_ai.request.model": model,
            "gen_ai.usage.input_tokens": input_tokens,
            "gen_ai.usage.output_tokens": output_tokens,
            "loopit.cost_usd": cost_usd,
            "loopit.cache_hit_fraction": cache_hit_fraction,
            **attributes,
        },
    ) as span:
        yield span


@contextmanager
def span_sandbox_lease(
    correlation: CorrelationIds, *, lease_id: str, action: str, **attributes: Any
) -> Iterator[Span]:
    with _span(
        "loopit.sandbox.lease",
        correlation,
        {"loopit.lease_id": lease_id, "loopit.lease_action": action, **attributes},
    ) as span:
        yield span


@contextmanager
def span_verification_layer(
    correlation: CorrelationIds, *, layer: str, **attributes: Any
) -> Iterator[Span]:
    with _span(
        "loopit.verification.layer", correlation, {"loopit.verification_layer": layer, **attributes}
    ) as span:
        yield span


@contextmanager
def _span(name: str, correlation: CorrelationIds, attributes: Mapping[str, Any]) -> Iterator[Span]:
    tracer = trace.get_tracer("loopit.telemetry")
    with tracer.start_as_current_span(
        name,
        attributes=scrub_attributes({**correlation.attributes(), **attributes}),
    ) as span:
        try:
            yield span
            span.set_status(Status(StatusCode.OK))
        except Exception as exc:
            span.record_exception(exc)
            span.set_status(Status(StatusCode.ERROR))
            raise
