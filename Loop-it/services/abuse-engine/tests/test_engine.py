from __future__ import annotations

from datetime import UTC, datetime, timedelta

from loopit_abuse import (
    AbuseEngine,
    AbuseSignal,
    FakeSandboxKiller,
    FakeTenantSuspender,
    FakeThrottler,
)
from loopit_abuse.models import AbuseTaxon, SignalKind
from loopit_agent_core.audit import InMemoryAuditSink

NOW = datetime(2026, 1, 1, tzinfo=UTC)


def engine(
    *, dry_run: bool = False
) -> tuple[AbuseEngine, FakeSandboxKiller, FakeThrottler, FakeTenantSuspender, InMemoryAuditSink]:
    killer = FakeSandboxKiller()
    throttler = FakeThrottler()
    suspender = FakeTenantSuspender()
    audit = InMemoryAuditSink()
    return (
        AbuseEngine(
            killer=killer, throttler=throttler, suspender=suspender, audit=audit, dry_run=dry_run
        ),
        killer,
        throttler,
        suspender,
        audit,
    )


def signal(signal_id: str, kind: SignalKind = "egress_denial", **detail: object) -> AbuseSignal:
    return AbuseSignal(
        signal_id=signal_id,
        tenant_id="tenant",
        project_id="project",
        sandbox_id="sandbox",
        lease_id="lease",
        kind=kind,
        occurred_at=NOW,
        detail=dict(detail),
    )


def test_sliding_window_scoring_expires_old_signals() -> None:
    abuse, *_ = engine()
    old = AbuseSignal(
        signal_id="old",
        tenant_id="tenant",
        kind="egress_denial",
        occurred_at=NOW - timedelta(seconds=400),
    )
    recent = AbuseSignal(signal_id="new", tenant_id="tenant", kind="egress_denial", occurred_at=NOW)
    score = abuse.score([old, recent], NOW)
    assert score.points == 10
    assert score.tier == "T0"


def test_ladder_tiers_trigger_expected_enforcement() -> None:
    abuse, killer, throttler, suspender, _audit = engine()
    assert abuse.ingest(signal("t0")) is not None
    abuse.ingest(signal("t1", count=4))
    abuse_t2, killer_t2, *_ = engine()
    abuse_t2.ingest(signal("t2", kind="unexpected_gpu_usage"))
    abuse.ingest(signal("t3", kind="auth_brute_force", count=10))
    assert throttler.calls
    assert killer.calls == []
    assert killer_t2.calls
    assert suspender.suspended


def test_miner_heuristic_true_and_false_positive() -> None:
    abuse, killer, *_ = engine()
    incident = abuse.ingest(
        signal(
            "miner",
            kind="cpu_saturation_without_build_progress",
            cpu_percent=96,
            duration_seconds=180,
            build_progress_events=0,
        )
    )
    assert incident is not None
    assert incident.taxon is AbuseTaxon.MINER
    assert incident.tier == "T2"
    assert killer.calls

    clean, clean_killer, *_ = engine()
    clean_incident = clean.ingest(
        signal(
            "build",
            kind="cpu_saturation_without_build_progress",
            cpu_percent=96,
            duration_seconds=180,
            build_progress_events=3,
        )
    )
    assert clean_incident is not None
    assert clean_incident.tier == "T1"
    assert clean_killer.calls == []


def test_dry_run_performs_no_enforcement_but_audits() -> None:
    abuse, killer, throttler, suspender, audit = engine(dry_run=True)
    abuse.ingest(signal("gpu", kind="unexpected_gpu_usage"))
    assert killer.calls == []
    assert throttler.calls == []
    assert suspender.suspended == []
    assert audit.of_type("abuse.action")[-1].detail["dry_run"] is True


def test_idempotent_repeat_signals_do_not_enforce_twice() -> None:
    abuse, killer, *_ = engine()
    first = abuse.ingest(signal("dup", kind="unexpected_gpu_usage"))
    second = abuse.ingest(signal("dup", kind="unexpected_gpu_usage"))
    assert first is second
    assert len(killer.calls) == 1


def test_allowlist_suppresses_false_positive() -> None:
    abuse, killer, *_ = engine()
    abuse.add_allowlist(
        tenant_id="tenant",
        taxon=AbuseTaxon.GPU_MISUSE,
        project_id="project",
        sandbox_id=None,
        actor_id="admin",
        reason="known gpu benchmark",
    )
    assert abuse.ingest(signal("gpu", kind="unexpected_gpu_usage")) is None
    assert killer.calls == []


def test_audit_emission_for_signal_and_action() -> None:
    abuse, *_rest, audit = engine()
    abuse.ingest(signal("gpu", kind="unexpected_gpu_usage"))
    assert audit.of_type("abuse.signal.ingested")
    assert audit.of_type("abuse.action")
