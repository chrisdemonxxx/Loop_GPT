"""Tests for verification layer L2.5, the security pass."""

from __future__ import annotations

import json
from collections.abc import Callable

import pytest
from loopit_verify.sast import (
    REDACTED,
    Action,
    Finding,
    Gate,
    SastParseError,
    SastReport,
    Severity,
    Stage,
    action_for,
    classify,
    collect,
    parse_gitleaks,
    parse_npm_audit,
    parse_semgrep,
    security_checks,
)


class TestFindingsPolicy:
    """Doc 08 §4's policy table, asserted row by row."""

    def test_critical_blocks_everywhere(self) -> None:
        for gate in Gate:
            assert action_for(Severity.CRITICAL, gate) is Action.BLOCK

    def test_high_blocks_on_deploy_but_only_warns_in_build(self) -> None:
        # The asymmetry is the point: blocking every build on a High would stall
        # the loop; letting one reach production would not be recoverable.
        assert action_for(Severity.HIGH, Gate.BUILD) is Action.WARN
        assert action_for(Severity.HIGH, Gate.DEPLOY) is Action.BLOCK

    @pytest.mark.parametrize("severity", [Severity.MEDIUM, Severity.LOW])
    def test_medium_and_low_never_block(self, severity: Severity) -> None:
        for gate in Gate:
            assert action_for(severity, gate) is Action.WARN


class TestClassification:
    def test_secret_stage_is_always_critical(self) -> None:
        # Scanners rank secrets by confidence; that is a useful triage signal
        # and a terrible gate. Doc 08 stage 1: block on any hit.
        assert classify("generic-api-key", Severity.LOW, Stage.SECRETS) is Severity.CRITICAL

    def test_client_secret_stage_is_always_critical(self) -> None:
        assert classify("anything", Severity.LOW, Stage.CLIENT_SECRETS) is Severity.CRITICAL

    @pytest.mark.parametrize(
        "rule_id",
        [
            "javascript.express.sql-injection",
            "python.django.SQLI.tainted-sql-string",
            "custom.auth-bypass.missing-check",
            "js.jwt-decode-without-verify",
            "postgres.rls-disabled",
        ],
    )
    def test_named_hard_block_classes_are_promoted(self, rule_id: str) -> None:
        # A scanner that rates SQL injection as a warning is still describing a
        # hard block.
        assert classify(rule_id, Severity.LOW, Stage.SAST) is Severity.CRITICAL

    def test_ordinary_findings_keep_their_reported_severity(self) -> None:
        assert classify("javascript.lang.unused-var", Severity.LOW, Stage.SAST) is Severity.LOW


class TestSemgrep:
    def test_parses_results(self) -> None:
        payload = json.dumps(
            {
                "results": [
                    {
                        "check_id": "javascript.express.security.xss",
                        "path": "server/routes.ts",
                        "start": {"line": 42},
                        "extra": {"severity": "ERROR", "message": "Reflected XSS"},
                    }
                ]
            }
        )
        (finding,) = parse_semgrep(payload)
        assert finding.severity is Severity.HIGH
        assert finding.path == "server/routes.ts"
        assert finding.line == 42
        assert "XSS" in finding.message

    def test_sql_injection_is_critical_even_when_reported_as_a_warning(self) -> None:
        payload = json.dumps(
            {
                "results": [
                    {
                        "check_id": "js.sql-injection",
                        "path": "db.ts",
                        "start": {"line": 3},
                        "extra": {"severity": "WARNING", "message": "concatenated query"},
                    }
                ]
            }
        )
        (finding,) = parse_semgrep(payload)
        assert finding.severity is Severity.CRITICAL
        assert finding.action(Gate.BUILD) is Action.BLOCK

    def test_no_results_is_a_clean_scan(self) -> None:
        assert parse_semgrep(json.dumps({"results": []})) == ()


class TestGitleaks:
    def test_the_matched_secret_is_never_rendered(self) -> None:
        # A finding travels into the model's context and the audit log. Copying
        # the credential into both is the opposite of what the scan is for.
        payload = json.dumps(
            [
                {
                    "RuleID": "stripe-access-token",
                    "Description": "Stripe key",
                    "File": "src/config.ts",
                    "StartLine": 7,
                    "Secret": "sk_live_TOTALLYNOTAREALKEY",
                    "Match": 'const k = "sk_live_TOTALLYNOTAREALKEY"',
                }
            ]
        )
        (finding,) = parse_gitleaks(payload)
        rendered = finding.render()
        assert "TOTALLYNOTAREALKEY" not in rendered
        assert REDACTED in rendered

    def test_every_hit_is_critical(self) -> None:
        payload = json.dumps(
            [{"RuleID": "generic", "Description": "d", "File": "f", "StartLine": 1}]
        )
        (finding,) = parse_gitleaks(payload)
        assert finding.severity is Severity.CRITICAL

    def test_null_report_is_clean(self) -> None:
        assert parse_gitleaks("null") == ()

    def test_a_non_array_report_is_an_error_not_a_pass(self) -> None:
        with pytest.raises(SastParseError):
            parse_gitleaks(json.dumps({"unexpected": True}))


class TestNpmAudit:
    def test_parses_vulnerabilities(self) -> None:
        payload = json.dumps(
            {"vulnerabilities": {"lodash": {"severity": "high", "range": "<4.17.21"}}}
        )
        (finding,) = parse_npm_audit(payload)
        assert finding.severity is Severity.HIGH
        assert finding.stage is Stage.DEPENDENCIES

    def test_npm_critical_is_high_not_critical(self) -> None:
        # Otherwise any upstream CVE disclosure freezes every project on the
        # platform mid-iteration.
        payload = json.dumps({"vulnerabilities": {"x": {"severity": "critical", "range": "*"}}})
        (finding,) = parse_npm_audit(payload)
        assert finding.severity is Severity.HIGH
        assert finding.action(Gate.BUILD) is Action.WARN
        assert finding.action(Gate.DEPLOY) is Action.BLOCK


class TestBrokenScanners:
    @pytest.mark.parametrize("parser", [parse_semgrep, parse_npm_audit, parse_gitleaks])
    def test_unreadable_output_raises_rather_than_reporting_clean(
        self, parser: Callable[[str], tuple[Finding, ...]]
    ) -> None:
        # A scanner that crashed and a scanner that found nothing must never be
        # indistinguishable, or a broken gate becomes a passing one.
        with pytest.raises(SastParseError):
            parser("semgrep: command not found")


class TestReport:
    def _report(self) -> SastReport:
        return collect(
            [
                Finding("a.sqli", Severity.CRITICAL, Stage.SAST, "sqli"),
                Finding("b.ssrf", Severity.HIGH, Stage.SAST, "ssrf"),
                Finding("c.cors", Severity.MEDIUM, Stage.CONFIG, "weak cors"),
            ]
        )

    def test_worst_findings_sort_first(self) -> None:
        report = collect(
            [
                Finding("low", Severity.LOW, Stage.SAST, "m"),
                Finding("crit", Severity.CRITICAL, Stage.SAST, "m"),
                Finding("high", Severity.HIGH, Stage.SAST, "m"),
            ]
        )
        assert [f.severity for f in report.findings] == [
            Severity.CRITICAL,
            Severity.HIGH,
            Severity.LOW,
        ]

    def test_the_same_report_gates_differently(self) -> None:
        report = collect(
            [
                Finding("a.sqli", Severity.CRITICAL, Stage.SAST, "sqli"),
                Finding("b.ssrf", Severity.HIGH, Stage.SAST, "ssrf"),
            ]
        )
        assert len(report.blocking(Gate.BUILD)) == 1
        assert len(report.blocking(Gate.DEPLOY)) == 2
        assert not report.passed(Gate.BUILD)

    def test_a_clean_report_passes_both_gates(self) -> None:
        report = collect([])
        assert report.passed(Gate.BUILD)
        assert report.passed(Gate.DEPLOY)
        assert "passed, no findings" in report.observation(Gate.DEPLOY)

    def test_blocking_findings_are_never_truncated_away(self) -> None:
        # A Critical hidden behind forty Medium findings is a Critical nobody fixes.
        findings = [Finding(f"m{i}", Severity.MEDIUM, Stage.SAST, "m") for i in range(80)]
        findings.append(Finding("z.sqli", Severity.CRITICAL, Stage.SAST, "sqli here"))
        observation = collect(findings).observation(Gate.BUILD, limit=10)
        assert "sqli here" in observation
        assert "more advisory findings" in observation

    def test_the_observation_tells_the_agent_what_to_do(self) -> None:
        observation = self._report().observation(Gate.DEPLOY)
        assert "MUST FIX" in observation


class TestChecks:
    def test_stages_run_cheapest_first(self) -> None:
        assert [c.name for c in security_checks()] == [
            "secret-scan",
            "dependency-audit",
            "sast",
        ]

    def test_the_secret_scan_blocks(self) -> None:
        secret_scan = security_checks()[0]
        assert secret_scan.blocking

    def test_the_secret_scan_redacts_its_own_report(self) -> None:
        assert "--redact" in security_checks()[0].command

    def test_the_dependency_audit_does_not_block_the_build(self) -> None:
        assert not security_checks()[1].blocking

    def test_every_check_is_bounded(self) -> None:
        assert all(check.timeout_seconds > 0 for check in security_checks())
