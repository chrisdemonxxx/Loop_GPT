from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from importlib.metadata import PackageNotFoundError, version
from typing import Any

from opentelemetry import metrics, trace
from opentelemetry.exporter.otlp.proto.http._log_exporter import OTLPLogExporter
from opentelemetry.exporter.otlp.proto.http.metric_exporter import OTLPMetricExporter
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk._logs import LoggerProvider, LoggingHandler
from opentelemetry.sdk._logs.export import BatchLogRecordProcessor, LogExporter
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import (
    MetricReader,
    PeriodicExportingMetricReader,
)
from opentelemetry.sdk.resources import SERVICE_NAME, SERVICE_VERSION, Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import (
    BatchSpanProcessor,
    SimpleSpanProcessor,
    SpanExporter,
    SpanExportResult,
)
from opentelemetry.sdk.trace.sampling import ALWAYS_OFF, ALWAYS_ON, ParentBased, TraceIdRatioBased

from .logging import configure_json_logging

LOG = logging.getLogger("loopit.telemetry")
_CONFIGURED = False


@dataclass(frozen=True, slots=True)
class TelemetryConfig:
    service_name: str
    endpoint: str | None
    enabled: bool
    service_version: str
    sample_ratio: float


def configure_telemetry(
    service_name: str,
    *,
    span_exporter: SpanExporter | None = None,
    metric_reader: MetricReader | None = None,
    log_exporter: LogExporter | None = None,
    force: bool = False,
) -> TelemetryConfig:
    """Configure OTel from standard env vars, or stay no-op when no exporter exists."""

    global _CONFIGURED
    endpoint = os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT", "").strip() or None
    resolved_name = os.environ.get("OTEL_SERVICE_NAME", service_name)
    sample_ratio = _sample_ratio()
    config = TelemetryConfig(
        service_name=resolved_name,
        endpoint=endpoint,
        enabled=bool(endpoint or span_exporter or metric_reader or log_exporter),
        service_version=_package_version(),
        sample_ratio=sample_ratio,
    )
    configure_json_logging()
    if not config.enabled:
        return config
    if force:
        _reset_otel_globals()
        _CONFIGURED = False
    if _CONFIGURED and not force:
        return config

    resource = Resource.create(
        {
            SERVICE_NAME: resolved_name,
            SERVICE_VERSION: config.service_version,
            "deployment.environment": os.environ.get("OTEL_RESOURCE_ATTRIBUTES_ENV", "dev"),
            **_resource_attributes(),
        }
    )

    try:
        tracer_provider = TracerProvider(resource=resource, sampler=_sampler(sample_ratio))
        safe_exporter = _SafeSpanExporter(span_exporter or OTLPSpanExporter())
        processor = (
            SimpleSpanProcessor(safe_exporter)
            if span_exporter is not None
            else BatchSpanProcessor(safe_exporter)
        )
        tracer_provider.add_span_processor(processor)
        trace.set_tracer_provider(tracer_provider)
    except Exception as exc:  # pragma: no cover - defensive startup guard.
        LOG.warning("otel trace setup disabled", extra={"error": type(exc).__name__})

    try:
        reader = metric_reader or PeriodicExportingMetricReader(OTLPMetricExporter())
        metrics.set_meter_provider(MeterProvider(metric_readers=[reader], resource=resource))
    except Exception as exc:  # pragma: no cover - defensive startup guard.
        LOG.warning("otel metric setup disabled", extra={"error": type(exc).__name__})

    try:
        logger_provider = LoggerProvider(resource=resource)
        logger_provider.add_log_record_processor(
            BatchLogRecordProcessor(log_exporter or OTLPLogExporter())
        )
        root = logging.getLogger()
        if not any(isinstance(handler, LoggingHandler) for handler in root.handlers):
            root.addHandler(LoggingHandler(level=logging.NOTSET, logger_provider=logger_provider))
    except Exception as exc:  # pragma: no cover - defensive startup guard.
        LOG.warning("otel log setup disabled", extra={"error": type(exc).__name__})

    _CONFIGURED = True
    return config


def _resource_attributes() -> dict[str, str]:
    raw = os.environ.get("OTEL_RESOURCE_ATTRIBUTES", "")
    attrs: dict[str, str] = {}
    for item in raw.split(","):
        key, sep, value = item.partition("=")
        key = key.strip()
        if sep and key.startswith(("service.", "deployment.", "cloud.", "host.")):
            attrs[key] = value.strip()
    return attrs


def _sample_ratio() -> float:
    sampler = os.environ.get("OTEL_TRACES_SAMPLER", "parentbased_traceidratio").lower()
    arg = os.environ.get("OTEL_TRACES_SAMPLER_ARG", "1.0")
    if sampler in {"always_off", "off"}:
        return 0.0
    if sampler in {"always_on", "on"}:
        return 1.0
    try:
        return min(1.0, max(0.0, float(arg)))
    except ValueError:
        return 1.0


def _sampler(ratio: float) -> Any:
    if ratio <= 0:
        return ALWAYS_OFF
    if ratio >= 1:
        return ALWAYS_ON
    return ParentBased(TraceIdRatioBased(ratio))


def _package_version() -> str:
    try:
        return version("loopit-telemetry")
    except PackageNotFoundError:
        return "0.0.0"


class _SafeSpanExporter(SpanExporter):
    def __init__(self, wrapped: SpanExporter) -> None:
        self._wrapped = wrapped

    def export(self, spans: Any) -> SpanExportResult:
        try:
            return self._wrapped.export(spans)
        except Exception as exc:  # pragma: no cover - exporter failure path.
            LOG.warning("otel span export failed", extra={"error": type(exc).__name__})
            return SpanExportResult.FAILURE

    def shutdown(self) -> None:
        try:
            self._wrapped.shutdown()
        except Exception:
            return None

    def force_flush(self, timeout_millis: int = 30000) -> bool:
        try:
            return self._wrapped.force_flush(timeout_millis)
        except Exception:
            return False


def _reset_otel_globals() -> None:
    try:
        import opentelemetry._logs._internal as logs_internal
        import opentelemetry.metrics._internal as metrics_internal
        import opentelemetry.trace as trace_internal

        trace_internal._TRACER_PROVIDER = None
        trace_internal._TRACER_PROVIDER_SET_ONCE._done = False
        metrics_internal._METER_PROVIDER = None
        metrics_internal._METER_PROVIDER_SET_ONCE._done = False
        logs_internal._LOGGER_PROVIDER = None
        logs_internal._LOGGER_PROVIDER_SET_ONCE._done = False
    except Exception:
        return None
