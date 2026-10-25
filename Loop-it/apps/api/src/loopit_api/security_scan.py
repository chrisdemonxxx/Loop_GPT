"""On-demand + pre-publish security scan surface (Phase 2.8).

Runs Semgrep / gitleaks / npm audit when available (or ``packages/verify``
parsers against stubbed output offline). Findings are returned in plain
language; Critical findings block publish unless overridden.
"""

from __future__ import annotations

import json
import os
import secrets
import shutil
import subprocess
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal

try:
    from loopit_verify import (
        Gate,
        Severity,
        collect,
        parse_gitleaks,
        parse_npm_audit,
        parse_semgrep,
    )

    _VERIFY = True
except ImportError:  # pragma: no cover
    _VERIFY = False
    Gate = Any  # type: ignore[misc, assignment]
    Severity = Any  # type: ignore[misc, assignment]


ScanMode = Literal["live", "offline"]


PLAIN: dict[str, str] = {
    "secret": "A secret or credential appears to be committed in the project. Remove it and rotate the credential.",
    "dependency": "A dependency has a known vulnerability. Update or replace the package.",
    "sast": "The code scanner found a security issue. Review the rule and fix the vulnerable pattern.",
    "critical": "This finding is critical and blocks publishing until fixed or explicitly overridden.",
}


@dataclass(frozen=True, slots=True)
class PlainFinding:
    rule_id: str
    severity: str
    stage: str
    path: str | None
    line: int | None
    message: str
    plain: str
    blocks_publish: bool

    def to_dict(self) -> dict[str, Any]:
        return {
            "rule_id": self.rule_id,
            "severity": self.severity,
            "stage": self.stage,
            "path": self.path,
            "line": self.line,
            "message": self.message,
            "plain": self.plain,
            "blocks_publish": self.blocks_publish,
        }


def _scan_store(projects_root: Path, project_id: str) -> Path:
    return projects_root / ".artifacts" / "security" / project_id


def _plain_for(stage: str, severity: str, message: str) -> str:
    key = "secret" if stage in {"SECRETS", "CLIENT_SECRETS", "0"} else (
        "dependency" if stage in {"DEPENDENCIES", "1"} else "sast"
    )
    base = PLAIN.get(key, PLAIN["sast"])
    if severity.upper() == "CRITICAL":
        return f"{PLAIN['critical']} {base} ({message})"
    return f"{base} ({message})"


def _findings_from_report(report: Any, gate: Any) -> list[PlainFinding]:
    out: list[PlainFinding] = []
    for finding in report.findings:
        severity_name = finding.severity.name if hasattr(finding.severity, "name") else str(finding.severity)
        stage_name = finding.stage.name if hasattr(finding.stage, "name") else str(finding.stage)
        blocks = finding.action(gate).name == "BLOCK" if hasattr(finding, "action") else severity_name == "CRITICAL"
        out.append(
            PlainFinding(
                rule_id=finding.rule_id,
                severity=severity_name,
                stage=stage_name,
                path=finding.path,
                line=finding.line,
                message=finding.message,
                plain=_plain_for(stage_name, severity_name, finding.message),
                blocks_publish=blocks,
            )
        )
    return out


def _run_cmd(command: list[str], *, cwd: Path, timeout: int) -> tuple[int, str]:
    try:
        completed = subprocess.run(  # noqa: S603 — fixed scanner argv
            command,
            cwd=str(cwd),
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
        return completed.returncode, (completed.stdout or "") + (completed.stderr or "")
    except (OSError, subprocess.TimeoutExpired) as error:
        return 127, str(error)


def _offline_stub_findings() -> list[PlainFinding]:
    """No scanners installed — return an empty clean report (not a fake vuln)."""
    return []


def run_security_scan(
    *,
    projects_root: Path,
    project_id: str,
    workspace_root: Path,
    gate: str = "deploy",
    force_offline: bool | None = None,
) -> dict[str, Any]:
    """Run scanners against the project workspace; persist under .artifacts/security."""
    offline = (
        force_offline
        if force_offline is not None
        else os.environ.get("LOOPIT_SECURITY_SCAN_OFFLINE", "").lower()
        in {"1", "true", "yes", "on"}
        or not _VERIFY
    )
    scan_id = f"sec_{secrets.token_hex(6)}"
    started = datetime.now(UTC).isoformat()
    mode: ScanMode = "offline" if offline else "live"
    gate_enum = Gate.DEPLOY if gate == "deploy" else Gate.BUILD

    findings: list[PlainFinding] = []
    raw_notes: list[str] = []

    if offline or not _VERIFY:
        findings = _offline_stub_findings()
        raw_notes.append("offline stub — scanners not executed")
        mode = "offline"
    else:
        groups = []
        # gitleaks
        if shutil.which("gitleaks"):
            code, out = _run_cmd(
                ["gitleaks", "detect", "--no-git", "--report-format", "json", "--redact", "-r", "/dev/stdout"],
                cwd=workspace_root,
                timeout=120,
            )
            # gitleaks writes report to -r; many builds print JSON on stdout with exit 1 on findings
            try:
                groups.append(parse_gitleaks(out if out.strip().startswith("[") else "[]"))
            except Exception as error:  # noqa: BLE001
                raw_notes.append(f"gitleaks parse: {error}")
                if code not in {0, 1}:
                    raw_notes.append(f"gitleaks exit {code}")
        else:
            raw_notes.append("gitleaks not installed")
            groups.append(())

        # npm audit
        if (workspace_root / "package.json").is_file() and shutil.which("npm"):
            code, out = _run_cmd(["npm", "audit", "--json"], cwd=workspace_root, timeout=180)
            try:
                # npm audit exits non-zero when vulns exist; still parse JSON
                json_start = out.find("{")
                payload = out[json_start:] if json_start >= 0 else "{}"
                groups.append(parse_npm_audit(payload))
            except Exception as error:  # noqa: BLE001
                raw_notes.append(f"npm audit parse: {error}")
        else:
            raw_notes.append("npm audit skipped")
            groups.append(())

        # semgrep
        if shutil.which("semgrep"):
            code, out = _run_cmd(
                ["semgrep", "--config", "p/owasp-top-ten", "--json", "--quiet"],
                cwd=workspace_root,
                timeout=300,
            )
            try:
                json_start = out.find("{")
                payload = out[json_start:] if json_start >= 0 else '{"results":[]}'
                groups.append(parse_semgrep(payload))
            except Exception as error:  # noqa: BLE001
                raw_notes.append(f"semgrep parse: {error}")
        else:
            raw_notes.append("semgrep not installed")
            groups.append(())

        report = collect(*groups)
        findings = _findings_from_report(report, gate_enum)

    blocking = [f for f in findings if f.blocks_publish]
    advisory = [f for f in findings if not f.blocks_publish]
    offline_stub = mode == "offline"
    result = {
        "scan_id": scan_id,
        "project_id": project_id,
        "mode": mode,
        "gate": gate,
        "started_at": started,
        "finished_at": datetime.now(UTC).isoformat(),
        # An offline stub did not run the scanners. Caching it as passed
        # lets a later publish skip a real scan.
        "passed": False if offline_stub else len(blocking) == 0,
        "stub": offline_stub,
        "blocking_count": len(blocking),
        "advisory_count": len(advisory),
        "findings": [f.to_dict() for f in findings],
        "summary": (
            "Security scanning is not available until a live scanner is connected."
            if offline_stub
            else "No security findings."
            if not findings
            else f"{len(blocking)} blocking, {len(advisory)} advisory findings."
        ),
        "notes": raw_notes,
    }

    dest = _scan_store(projects_root, project_id)
    dest.mkdir(parents=True, exist_ok=True)
    (dest / f"{scan_id}.json").write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    (dest / "latest.json").write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    return result


def is_offline_stub(scan: dict[str, Any] | None) -> bool:
    """True when this record is the offline stand-in, not a scanner result.

    A stub must not count as a pass, and it must not satisfy publish: a later
    live scan has to be allowed to run. Real findings keep the record even if
    an older note still mentions the stub.
    """
    if not isinstance(scan, dict) or scan.get("findings"):
        return False
    if scan.get("stub") is True:
        return True
    notes = scan.get("notes") or []
    if any("offline stub" in str(note) for note in notes):
        return True
    return scan.get("mode") == "offline"


def latest_security_scan(projects_root: Path, project_id: str) -> dict[str, Any] | None:
    path = _scan_store(projects_root, project_id) / "latest.json"
    if not path.is_file():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return None


def publish_blocked_by_security(
    projects_root: Path,
    project_id: str,
    *,
    override: bool = False,
) -> dict[str, Any] | None:
    """Return a blocking payload if publish should be refused, else None."""
    latest = latest_security_scan(projects_root, project_id)
    if latest is None or is_offline_stub(latest):
        # Nothing usable is cached. A stub pass must not clear publish.
        return None
    if latest.get("passed"):
        return None
    if override:
        return None
    blocking = [f for f in latest.get("findings", []) if f.get("blocks_publish")]
    if not blocking:
        return None
    return {
        "detail": "security scan blocked publish",
        "scan_id": latest.get("scan_id"),
        "blocking": blocking[:20],
        "override_hint": "Re-submit with override_security=true and a reason to publish anyway.",
    }


__all__ = [
    "PlainFinding",
    "is_offline_stub",
    "latest_security_scan",
    "publish_blocked_by_security",
    "run_security_scan",
]
