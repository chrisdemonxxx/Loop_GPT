from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from opentelemetry import metrics

from .attributes import scrub_attributes


@dataclass(slots=True)
class LoopItMetrics:
    request_counter: Any
    error_counter: Any
    duration_histogram: Any
    saturation_gauge: Any
    iterations_histogram: Any
    tokens_histogram: Any
    sandbox_cold_start_histogram: Any
    eval_success_counter: Any
    deploy_counter: Any
    deploy_cost_counter: Any

    def record_request(
        self, *, service: str, route: str, method: str, status_code: int, duration_ms: float
    ) -> None:
        attrs = scrub_attributes(
            {"service": service, "route": route, "method": method, "status_code": status_code}
        )
        self.request_counter.add(1, attrs)
        self.duration_histogram.record(duration_ms, attrs)
        if status_code >= 500:
            self.error_counter.add(1, attrs)

    def record_saturation(self, value: float, **attributes: Any) -> None:
        self.saturation_gauge.set(value, scrub_attributes(attributes))

    def record_iterations_per_build(self, iterations: int, **attributes: Any) -> None:
        self.iterations_histogram.record(iterations, scrub_attributes(attributes))

    def record_tokens_per_task(self, tokens: int, **attributes: Any) -> None:
        self.tokens_histogram.record(tokens, scrub_attributes(attributes))

    def record_sandbox_cold_start(self, latency_ms: float, **attributes: Any) -> None:
        self.sandbox_cold_start_histogram.record(latency_ms, scrub_attributes(attributes))

    def record_eval_result(self, *, success: bool, **attributes: Any) -> None:
        self.eval_success_counter.add(1, scrub_attributes({**attributes, "success": success}))

    def record_deploy_cost(self, *, success: bool, cost_usd: float, **attributes: Any) -> None:
        attrs = scrub_attributes({**attributes, "success": success})
        self.deploy_counter.add(1, attrs)
        self.deploy_cost_counter.add(cost_usd, attrs)


def get_metrics(meter_name: str = "loopit.telemetry") -> LoopItMetrics:
    meter = metrics.get_meter(meter_name)
    return LoopItMetrics(
        request_counter=meter.create_counter(
            "loopit.request.count", unit="1", description="Request rate by route."
        ),
        error_counter=meter.create_counter(
            "loopit.request.errors", unit="1", description="5xx error count by route."
        ),
        duration_histogram=meter.create_histogram(
            "loopit.request.duration_ms", unit="ms", description="Request latency."
        ),
        saturation_gauge=meter.create_gauge(
            "loopit.saturation",
            unit="1",
            description="Capacity saturation such as queue depth or active leases.",
        ),
        iterations_histogram=meter.create_histogram(
            "loopit.iterations_per_build", unit="1", description="Agent iterations per build."
        ),
        tokens_histogram=meter.create_histogram(
            "loopit.tokens_per_task", unit="tokens", description="Tokens consumed per task."
        ),
        sandbox_cold_start_histogram=meter.create_histogram(
            "loopit.sandbox.cold_start_ms", unit="ms", description="Sandbox cold-start latency."
        ),
        eval_success_counter=meter.create_counter(
            "loopit.eval.result", unit="1", description="Eval pass/fail outcomes."
        ),
        deploy_counter=meter.create_counter(
            "loopit.deploy.count", unit="1", description="Deploy attempts by outcome."
        ),
        deploy_cost_counter=meter.create_counter(
            "loopit.deploy.cost_usd",
            unit="USD",
            description="Deploy cost numerator for cost_per_successful_deploy.",
        ),
    )


def record_cost_per_successful_deploy(
    *, total_cost_usd: float, successful_deploys: int, **attributes: Any
) -> float:
    value = total_cost_usd / successful_deploys if successful_deploys else 0.0
    meter = metrics.get_meter("loopit.telemetry")
    meter.create_histogram(
        "loopit.cost_per_successful_deploy",
        unit="USD/deploy",
        description="North-star cost KPI: total run cost divided by successful deploys.",
    ).record(value, scrub_attributes(attributes))
    return value
