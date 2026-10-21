from __future__ import annotations

import io
import json
import logging
import shutil
from collections.abc import Sequence
from pathlib import Path

import pytest
from loopit_agent_core.audit import AuditEvent
from loopit_store.memory import InMemoryAuditStore
from loopit_telemetry import (
    AuditWormMirror,
    CorrelationIds,
    FakeObjectStore,
    JsonLogFormatter,
    LocalObjectStore,
    configure_telemetry,
    get_metrics,
    span_agent_step,
    span_model_call,
    span_run,
    verify_audit_mirror,
)
from loopit_telemetry.attributes import REDACTED, scrub_attributes, scrub_log_record
from opentelemetry.sdk.metrics.export import InMemoryMetricReader
from opentelemetry.sdk.trace.export import SpanExporter, SpanExportResult
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter


class FailingSpanExporter(SpanExporter):
    def export(self, spans: Sequence[object]) -> SpanExportResult:
        del spans
        raise RuntimeError("collector down")

    def shutdown(self) -> None:
        return None


def test_noop_without_endpoint(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("OTEL_EXPORTER_OTLP_ENDPOINT", raising=False)
    config = configure_telemetry("unit-test-noop")
    assert config.enabled is False
    with span_run(CorrelationIds("tenant", "project", "run")):
        pass


def test_exporter_failure_never_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("OTEL_EXPORTER_OTLP_ENDPOINT", raising=False)
    config = configure_telemetry(
        "unit-test-failure", span_exporter=FailingSpanExporter(), force=True
    )
    assert config.enabled is True
    with span_agent_step(CorrelationIds("tenant", "project", "run"), step="think", iteration=1):
        pass


def test_scrubber_removes_secrets_and_pii() -> None:
    attrs = scrub_attributes(
        {
            "authorization": "Bearer sk-abc12345678901234567890",
            "message": "mail me at person@example.com with hf_abcdefghijklmnop1234",
            "nested": {"api_key": "ghp_abcdefghijklmnopqrstuvwxy1234567890"},
        }
    )
    assert attrs["authorization"] == REDACTED
    assert "person@example.com" not in str(attrs["message"])
    assert "hf_" not in str(attrs["message"])
    assert REDACTED in str(attrs["nested"])

    log = scrub_log_record({"msg": "user person@example.com", "password": "secret"})
    assert log["password"] == REDACTED
    assert log["msg"] == f"user {REDACTED}"


def test_span_metric_emission_and_run_correlation(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("OTEL_EXPORTER_OTLP_ENDPOINT", raising=False)
    exporter = InMemorySpanExporter()
    reader = InMemoryMetricReader()
    configure_telemetry(
        "unit-test-memory", span_exporter=exporter, metric_reader=reader, force=True
    )
    correlation = CorrelationIds("tenant-a", "project-a", "run-a", "task-a")

    with span_run(correlation):
        with span_agent_step(correlation, step="act", iteration=2):
            with span_model_call(
                correlation,
                model="test-model",
                input_tokens=3,
                output_tokens=5,
                cost_usd=0.01,
                cache_hit_fraction=0.25,
            ):
                pass
    spans = exporter.get_finished_spans()
    run_ids = set()
    for span in spans:
        attributes = span.attributes
        assert attributes is not None
        run_ids.add(attributes["loopit.run_id"])
    assert run_ids == {"run-a"}
    assert len({span.context.trace_id for span in spans}) == 1

    get_metrics().record_tokens_per_task(8, tenant_id="tenant-a", run_id="run-a")
    data = reader.get_metrics_data()
    assert data is not None
    names = {
        metric.name
        for rm in data.resource_metrics
        for sm in rm.scope_metrics
        for metric in sm.metrics
    }
    assert "loopit.tokens_per_task" in names


def test_json_log_trace_id_injection(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("OTEL_EXPORTER_OTLP_ENDPOINT", raising=False)
    configure_telemetry("unit-test-logs", span_exporter=InMemorySpanExporter(), force=True)
    stream = io.StringIO()
    handler = logging.StreamHandler(stream)
    handler.setFormatter(JsonLogFormatter())
    logger = logging.getLogger("test.trace")
    logger.handlers = [handler]
    logger.propagate = False
    logger.setLevel(logging.INFO)

    with span_run(CorrelationIds("tenant", "project", "run")):
        logger.info("hello", extra={"email": "person@example.com"})

    payload = json.loads(stream.getvalue())
    assert payload["trace_id"]
    assert payload["span_id"]
    assert payload["email"] == REDACTED


def test_worm_mirror_write_once_and_gap_detection() -> None:
    store = InMemoryAuditStore()
    first = store.append(
        AuditEvent(type="task.started", tenant_id="t1", actor_kind="agent", actor_id="a")
    )
    second = store.append(
        AuditEvent(type="task.completed", tenant_id="t1", actor_kind="agent", actor_id="a")
    )
    fake = FakeObjectStore()
    mirror = AuditWormMirror(fake)
    assert mirror.mirror_record(first).endswith(f"event={first.event_id}.json")
    with pytest.raises(FileExistsError):
        mirror.mirror_record(first)
    assert verify_audit_mirror(store, fake, tenant_id="t1").missing_audit_ids == (second.audit_id,)

    root = Path("packages/telemetry/tests/.local-worm-test")
    if root.exists():
        shutil.rmtree(root)
    try:
        local = LocalObjectStore(root)
        mirror = AuditWormMirror(local)
        mirror.mirror_record(first)
        mirror.mirror_record(second)
        result = verify_audit_mirror(store, local, tenant_id="t1")
        assert result.ok

        key = mirror.key_for(second)
        local._path(key).write_text("{}", encoding="utf-8")  # tamper outside the WORM API.
        assert verify_audit_mirror(store, local, tenant_id="t1").tampered_keys == (key,)
    finally:
        if root.exists():
            shutil.rmtree(root)
