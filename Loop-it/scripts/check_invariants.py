"""Static invariant guards (I1-I12).

Run in CI on every pull request. These are cheap structural checks that catch
the classes of mistake that are catastrophic and easy to make by accident. They
do not replace the red-team suite; they fail fast before it runs.

Each check maps to an invariant in ``PLAN.md`` §0.
"""

from __future__ import annotations

import ast
import re
import sys
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

#: Directories whose code runs in the trusted control plane. Generated code must
#: never execute here (I1).
CONTROL_PLANE_DIRS = (
    ROOT / "services" / "orchestrator",
    ROOT / "services" / "router-svc",
    ROOT / "services" / "scheduler",
    ROOT / "services" / "secrets-broker",
    ROOT / "services" / "billing",
    ROOT / "apps" / "api",
    ROOT / "services" / "loopit-mcp",
    ROOT / "packages" / "agent-core",
)

#: Execution primitives that would put generated code in the control plane.
FORBIDDEN_CALLS = {
    "eval",
    "exec",
    "compile",
    "__import__",
}
FORBIDDEN_ATTRS = {
    ("os", "system"),
    ("os", "popen"),
    ("os", "execv"),
    ("os", "execve"),
    ("os", "spawnl"),
    ("subprocess", "run"),
    ("subprocess", "call"),
    ("subprocess", "Popen"),
    ("subprocess", "check_output"),
    ("subprocess", "check_call"),
}

#: Value shapes that must never be committed (I2, Doc 06 §4).
SECRET_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("OpenAI-style key", re.compile(r"\bsk-[A-Za-z0-9]{32,}\b")),
    ("Hugging Face token", re.compile(r"\bhf_[A-Za-z0-9]{30,}\b")),
    ("GitHub PAT", re.compile(r"\bghp_[A-Za-z0-9]{36}\b")),
    ("AWS access key id", re.compile(r"\bAKIA[0-9A-Z]{16}\b")),
    ("private key block", re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----")),
)

SKIP_DIRS = {
    ".git",
    "node_modules",
    ".venv",
    "dist",
    ".turbo",
    "__pycache__",
    ".mypy_cache",
    ".ruff_cache",
    ".pytest_cache",
}

#: Marker for a line that matches a secret pattern but is a reviewed, published
#: non-secret (e.g. a vendor's documented example key used as a redaction
#: fixture). Every use is visible in review and in this grep.
ALLOW_MARKER = "invariant-allow: I2"


@dataclass(frozen=True)
class Violation:
    invariant: str
    path: Path
    line: int
    message: str

    def render(self) -> str:
        rel = self.path.relative_to(ROOT).as_posix()
        return f"{self.invariant} {rel}:{self.line}: {self.message}"


def iter_files(root: Path, suffixes: tuple[str, ...]) -> list[Path]:
    if not root.exists():
        return []
    found: list[Path] = []
    for path in root.rglob("*"):
        if any(part in SKIP_DIRS for part in path.parts):
            continue
        if path.is_file() and path.suffix in suffixes:
            found.append(path)
    return found


def check_no_execution_in_control_plane() -> list[Violation]:
    """I1: agent-generated code executes only in the data plane."""
    violations: list[Violation] = []
    for directory in CONTROL_PLANE_DIRS:
        for path in iter_files(directory, (".py",)):
            if "tests" in path.parts:
                continue
            try:
                tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
            except SyntaxError as exc:
                violations.append(
                    Violation("I1", path, exc.lineno or 0, f"could not parse: {exc.msg}")
                )
                continue
            for node in ast.walk(tree):
                if not isinstance(node, ast.Call):
                    continue
                func = node.func
                if isinstance(func, ast.Name) and func.id in FORBIDDEN_CALLS:
                    violations.append(
                        Violation(
                            "I1",
                            path,
                            node.lineno,
                            f"{func.id}() in a control-plane service; generated code "
                            "executes only in the data plane",
                        )
                    )
                elif isinstance(func, ast.Attribute) and isinstance(func.value, ast.Name):
                    pair = (func.value.id, func.attr)
                    if pair in FORBIDDEN_ATTRS:
                        violations.append(
                            Violation(
                                "I1",
                                path,
                                node.lineno,
                                f"{pair[0]}.{pair[1]}() in a control-plane service; "
                                "delegate execution to a leased sandbox",
                            )
                        )
    return violations


def check_no_committed_secrets() -> list[Violation]:
    """I2: no credentials in the repository, ever."""
    violations: list[Violation] = []
    suffixes = (".py", ".ts", ".tsx", ".js", ".json", ".yml", ".yaml", ".md", ".toml", ".env")
    for path in iter_files(ROOT, suffixes):
        if path.name in {"check_invariants.py", "audit.py"}:
            continue  # these files contain the detection patterns themselves
        try:
            text = path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue
        lines = text.splitlines()
        for label, pattern in SECRET_PATTERNS:
            for match in pattern.finditer(text):
                index = text[: match.start()].count("\n")
                line = lines[index] if index < len(lines) else ""
                if ALLOW_MARKER in line:
                    continue  # explicitly reviewed non-secret fixture
                violations.append(Violation("I2", path, index + 1, f"possible {label} committed"))
    return violations


def check_egress_default_is_deny() -> list[Violation]:
    """I3/I4: the egress default action is deny and metadata ranges are denied."""
    violations: list[Violation] = []
    policy = ROOT / "services" / "egress-proxy" / "src" / "loopit_egress" / "policy.py"
    if not policy.exists():
        return [Violation("I3", policy, 0, "egress policy engine is missing")]

    text = policy.read_text(encoding="utf-8")
    if 'default_action: Literal["deny"] = "deny"' not in text:
        violations.append(
            Violation("I3", policy, 0, "default_action is not structurally pinned to 'deny'")
        )
    for required in ("169.254.0.0/16", "metadata.google.internal", "fd00:ec2::/32"):
        if required not in text:
            violations.append(
                Violation("I4", policy, 0, f"{required} is not in the unconditional deny set")
            )
    return violations


def check_only_apply_patch_writes() -> list[Violation]:
    """I6: diff/patch is the only write path; no full-file rewrite tool exists."""
    schema = ROOT / "packages" / "contracts" / "schemas" / "tool-call.schema.json"
    if not schema.exists():
        return [Violation("I6", schema, 0, "tool-call schema is missing")]

    text = schema.read_text(encoding="utf-8")
    violations = []
    for banned in ("write_file", "overwrite_file", "put_file", "replace_file"):
        if f'"{banned}"' in text:
            violations.append(
                Violation(
                    "I6",
                    schema,
                    0,
                    f"tool {banned!r} exists; full-file rewrites of existing files are "
                    "forbidden - use apply_patch",
                )
            )
    if '"apply_patch"' not in text:
        violations.append(Violation("I6", schema, 0, "apply_patch tool is missing"))
    return violations


def check_destructive_tools_are_gated() -> list[Violation]:
    """I7: every destructive tool requires an approved confirmation gate."""
    tools = ROOT / "packages" / "agent-core" / "src" / "loopit_agent_core" / "tools.py"
    if not tools.exists():
        return [Violation("I7", tools, 0, "tool executor is missing")]

    text = tools.read_text(encoding="utf-8")
    violations = []
    if "DESTRUCTIVE_TOOLS" not in text or '"deploy"' not in text:
        violations.append(
            Violation("I7", tools, 0, "deploy is not registered as a destructive tool")
        )
    if "requires_gate" not in text:
        violations.append(Violation("I7", tools, 0, "no confirmation-gate check in the executor"))
    return violations


def check_every_locked_decision_has_an_adr() -> list[Violation]:
    """Governance: PLAN.md §1 decisions must each be backed by an ADR."""
    adr_dir = ROOT / "docs" / "adr"
    if not adr_dir.exists():
        return [Violation("ADR", adr_dir, 0, "docs/adr is missing")]
    records = [p for p in adr_dir.glob("*.md") if p.name not in {"TEMPLATE.md", "README.md"}]
    if not records:
        return [Violation("ADR", adr_dir, 0, "no ADRs found")]

    violations = []
    for record in records:
        text = record.read_text(encoding="utf-8")
        for section in ("## Context", "## Decision", "## Consequences", "## Revisit trigger"):
            if section not in text:
                violations.append(Violation("ADR", record, 0, f"missing section {section!r}"))
    return violations


def check_rls_is_generated_not_requested() -> list[Violation]:
    """I9: RLS is emitted structurally by the provisioning tool, never by the agent."""
    rls = ROOT / "packages" / "provision" / "src" / "loopit_provision" / "rls.py"
    if not rls.exists():
        return [Violation("I9", rls, 0, "the RLS generator is missing")]

    violations: list[Violation] = []
    text = rls.read_text(encoding="utf-8")

    # ENABLE alone leaves the table owner unrestricted, and generated apps
    # routinely connect as the role that owns their tables.
    for required, description in (
        ("ENABLE ROW LEVEL SECURITY", "tables are not RLS-enabled"),
        ("FORCE ROW LEVEL SECURITY", "RLS is not forced, so the table owner bypasses it"),
        ("REVOKE ALL", "PUBLIC access is not revoked"),
        ("WITH CHECK", "writes are unconstrained, so rows can be written cross-tenant"),
    ):
        if required not in text:
            violations.append(Violation("I9", rls, 0, description))

    # A flag the agent can set is a flag prompt injection can set. This looks for
    # a boolean toggle specifically, so `enable_rls_statements()` — a function
    # that unconditionally emits the statements — is not a false positive.
    toggle = re.compile(
        r"\b(?:enable_rls|rls_enabled|skip_rls|disable_rls|without_rls|rls)\s*[:=]\s*"
        r"(?:bool|True|False)\b"
    )
    for match in toggle.finditer(text):
        violations.append(
            Violation(
                "I9",
                rls,
                text[: match.start()].count("\n") + 1,
                f"{match.group(0)!r} makes RLS optional; it must be unconditional",
            )
        )

    schema = ROOT / "packages" / "provision" / "src" / "loopit_provision" / "schema.py"
    if not schema.exists():
        violations.append(Violation("I9", schema, 0, "the schema emitter is missing"))
    elif "assert_secured" not in schema.read_text(encoding="utf-8"):
        violations.append(
            Violation("I9", schema, 0, "emitted migrations are not checked by assert_secured")
        )

    # Any SQL that ships in the repo must secure every table it creates.
    create_table = re.compile(r'CREATE TABLE (?:IF NOT EXISTS )?"?(\w+)"?\."?(\w+)"?', re.I)
    for path in iter_files(ROOT, (".sql",)):
        sql = path.read_text(encoding="utf-8")
        for match in create_table.finditer(sql):
            table = match.group(2)
            if not re.search(rf'ALTER TABLE[^;]*"{table}"\s+FORCE ROW LEVEL SECURITY', sql, re.I):
                violations.append(
                    Violation(
                        "I9",
                        path,
                        sql[: match.start()].count("\n") + 1,
                        f"table {table!r} is created without FORCE ROW LEVEL SECURITY",
                    )
                )
    return violations


CHECKS = (
    check_no_execution_in_control_plane,
    check_no_committed_secrets,
    check_egress_default_is_deny,
    check_only_apply_patch_writes,
    check_destructive_tools_are_gated,
    check_rls_is_generated_not_requested,
    check_every_locked_decision_has_an_adr,
)


def main() -> int:
    violations: list[Violation] = []
    for check in CHECKS:
        found = check()
        status = "FAIL" if found else "ok  "
        print(f"{status} {check.__doc__.splitlines()[0] if check.__doc__ else check.__name__}")
        violations.extend(found)

    if violations:
        print("\nInvariant violations:", file=sys.stderr)
        for violation in violations:
            print(f"  {violation.render()}", file=sys.stderr)
        return 1

    print(f"\nAll {len(CHECKS)} invariant guards passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
