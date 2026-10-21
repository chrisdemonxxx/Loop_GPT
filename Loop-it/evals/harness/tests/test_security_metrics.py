"""Tests for the fleet-level security metrics (P2-9).

The Phase 2 exit gate is a percentage, so most of these tests are about the ways
a percentage can report safety that was never measured.
"""

from __future__ import annotations

from loopit_evals.security_metrics import (
    PROVISIONING_TIERS,
    dashboard,
    gate,
    measure_live_rls,
    measure_rls,
)
from loopit_provision import RlsVerificationResult

PROTECTED = """
CREATE TABLE IF NOT EXISTS "public"."tasks" (id uuid primary key);
ALTER TABLE "public"."tasks" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."tasks" FORCE ROW LEVEL SECURITY;
"""

ENABLE_ONLY = """
CREATE TABLE IF NOT EXISTS "public"."notes" (id uuid primary key);
ALTER TABLE "public"."notes" ENABLE ROW LEVEL SECURITY;
"""

BARE = 'CREATE TABLE "public"."audit" (id uuid primary key);'


class TestMeasurement:
    def test_a_forced_table_is_protected(self) -> None:
        coverage = measure_rls([PROTECTED])
        assert coverage.tables == ("tasks",)
        assert coverage.unprotected == ()
        assert coverage.percentage == 100.0

    def test_enable_without_force_is_not_protected(self) -> None:
        # ENABLE exempts the table owner, and generated apps routinely connect
        # as the role that owns their tables.
        coverage = measure_rls([ENABLE_ONLY])
        assert coverage.unprotected == ("notes",)
        assert coverage.percentage == 0.0

    def test_a_bare_create_table_is_counted_and_unprotected(self) -> None:
        # A schema that arrived by any route other than the provisioner still
        # counts, or the metric only measures the guard.
        coverage = measure_rls([BARE])
        assert coverage.unprotected == ("audit",)

    def test_quoting_and_schema_qualification_do_not_hide_a_match(self) -> None:
        sql = 'CREATE TABLE public.tasks (id uuid);\nALTER TABLE "tasks" FORCE ROW LEVEL SECURITY;'
        assert measure_rls([sql]).unprotected == ()

    def test_tables_are_counted_once_across_migrations(self) -> None:
        coverage = measure_rls([PROTECTED, PROTECTED])
        assert coverage.tables == ("tasks",)

    def test_protection_may_arrive_in_a_later_migration(self) -> None:
        later = 'ALTER TABLE "public"."notes" FORCE ROW LEVEL SECURITY;'
        assert measure_rls([ENABLE_ONLY, later]).unprotected == ()

    def test_mixed_migrations_name_only_the_offender(self) -> None:
        coverage = measure_rls([PROTECTED, ENABLE_ONLY])
        assert coverage.unprotected == ("notes",)
        assert coverage.percentage == 50.0

    def test_live_measurement_uses_post_provision_verifier(self) -> None:
        class FakeVerifier:
            def verify_schema(self, schema: str) -> RlsVerificationResult:
                assert schema == "p_example"
                return RlsVerificationResult(tables=("tasks", "notes"), unprotected=("notes",))

        coverage = measure_live_rls(FakeVerifier(), schema="p_example")

        assert coverage.tables == ("tasks", "notes")
        assert coverage.unprotected == ("notes",)


class TestEmptyDenominator:
    """ "0 of 0" must never render as 100%."""

    def test_nothing_generated_is_not_measured(self) -> None:
        coverage = measure_rls([])
        assert not coverage.measured
        assert coverage.percentage is None

    def test_an_unmeasured_provisioning_run_fails_the_gate(self) -> None:
        result = gate(measure_rls([]), tiers=["T2"])
        assert not result.passed
        assert "unmeasured, not clean" in result.failures[0]

    def test_an_unmeasured_t0_run_passes(self) -> None:
        # T0 edits existing code; it is not expected to provision.
        assert gate(measure_rls([]), tiers=["T0"]).passed

    def test_every_provisioning_tier_demands_a_measurement(self) -> None:
        for tier in PROVISIONING_TIERS:
            assert not gate(measure_rls([]), tiers=[tier]).passed


class TestGate:
    def test_full_coverage_passes(self) -> None:
        assert gate(measure_rls([PROTECTED]), tiers=["T2"]).passed

    def test_one_unprotected_table_fails_the_whole_run(self) -> None:
        # The gate is 100%, not "mostly".
        result = gate(measure_rls([PROTECTED, ENABLE_ONLY]), tiers=["T2"])
        assert not result.passed

    def test_the_failure_names_the_table(self) -> None:
        # A percentage says something is wrong; a name says where.
        result = gate(measure_rls([ENABLE_ONLY]), tiers=["T2"])
        assert "notes" in result.render()

    def test_unprotected_tables_fail_even_on_a_t0_run(self) -> None:
        # Not provisioning is acceptable. Provisioning badly is not.
        assert not gate(measure_rls([BARE]), tiers=["T0"]).passed


class TestDashboard:
    def test_the_payload_carries_the_headline_metric(self) -> None:
        payload = dashboard(measure_rls([PROTECTED]), tiers=["T2"])
        assert payload["rls"]["rls_coverage_percent"] == 100.0
        assert payload["gate_passed"] is True

    def test_an_unmeasured_run_reports_null_not_a_hundred(self) -> None:
        payload = dashboard(measure_rls([]), tiers=["T2"])
        assert payload["rls"]["rls_coverage_percent"] is None
        assert payload["gate_passed"] is False
