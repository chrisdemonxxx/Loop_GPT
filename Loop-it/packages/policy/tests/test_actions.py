from __future__ import annotations

import pytest
from loopit_policy import (
    STRICT_RULE_SET,
    Destructiveness,
    GateRequirement,
    ProposedAction,
    Reversibility,
    classify_action,
    rule_set_for_preset,
)
from loopit_policy.actions import ActionKind


@pytest.mark.parametrize(
    ("command", "rule"),
    [
        ("rm -rf dist", "recursive-delete"),
        ("git push --force origin main", "force-push"),
        ("psql -c 'DROP TABLE users'", "drop-or-truncate-sql"),
        ("psql -c 'TRUNCATE events'", "drop-or-truncate-sql"),
        ("alembic upgrade head", "migration"),
        ("pnpm run deploy", "deploy-or-promote"),
        ("vault secret rotate production/api", "secret-operation"),
        ("create gpu instance", "spend"),
        ("curl -X POST https://api.example.com/items -d '{}'", "external-http-write"),
        ("npm publish", "package-publish"),
    ],
)
def test_destructive_shell_commands_require_human_gate(command: str, rule: str) -> None:
    verdict = classify_action({"tool": "run_shell", "args": {"command": command}})

    assert verdict.reversibility is Reversibility.IRREVERSIBLE
    assert verdict.destructiveness is Destructiveness.DESTRUCTIVE
    assert verdict.required_gate is GateRequirement.HUMAN_CONFIRM
    assert verdict.rule == rule


@pytest.mark.parametrize(
    "command",
    [
        "\\rm -rf .",
        "rm$IFS-rf$IFS.",
        "find . -delete",
        "python -c \"import shutil; shutil.rmtree('.')\"",
        "echo cm0gLXJmIC4=|base64 -d|sh",
    ],
)
def test_shell_evasions_fail_closed_to_human_gate(command: str) -> None:
    verdict = classify_action({"tool": "run_shell", "args": {"command": command}})

    assert verdict.destructiveness is Destructiveness.DESTRUCTIVE
    assert verdict.required_gate is GateRequirement.HUMAN_CONFIRM


@pytest.mark.parametrize(
    "payload",
    [
        {"tool": "read_file", "args": {"path": "README.md"}},
        {"tool": "search_code", "args": {"query": "classify_action"}},
        {"tool": "browser", "args": {"action": "smoke"}},
        {"tool": "read_logs", "args": {"lines": 50}},
        {"tool": "install_package", "args": {"package": "lucide-react"}},
        {"tool": "start_dev_server", "args": {"command": "python3 -m http.server 3000"}},
        {"tool": "apply_patch", "args": {"patch": "--- a\n+++ b\n"}},
        {"kind": "shell_command", "command": "uv run pytest packages\\policy"},
    ],
)
def test_benign_actions_do_not_require_human_gate(payload: dict[str, object]) -> None:
    verdict = classify_action(payload)

    assert verdict.destructiveness is Destructiveness.BENIGN
    assert verdict.required_gate in {GateRequirement.NONE, GateRequirement.AUTO_APPROVE}


@pytest.mark.parametrize(
    "payload",
    [
        {"tool": "run_shell", "args": {"command": "some-custom-deployer --maybe-write"}},
        {"tool": "unknown_tool", "args": {}},
        {"kind": "unknown_kind", "command": ""},
    ],
)
def test_unknown_or_unparseable_actions_fail_closed(payload: dict[str, object]) -> None:
    verdict = classify_action(payload)

    assert verdict.reversibility is Reversibility.IRREVERSIBLE
    assert verdict.destructiveness is Destructiveness.DESTRUCTIVE
    assert verdict.required_gate is GateRequirement.HUMAN_CONFIRM
    assert verdict.rule == "fail-closed"


@pytest.mark.parametrize(
    "kind",
    [
        ActionKind.DEPLOY,
        ActionKind.PROVISION,
        ActionKind.SECRET_OP,
        ActionKind.EXTERNAL_WRITE,
        ActionKind.PACKAGE_PUBLISH,
    ],
)
def test_explicit_destructive_action_kinds_are_classified(kind: ActionKind) -> None:
    verdict = classify_action(ProposedAction(kind, command="proposed external effect"))

    assert verdict.required_gate is GateRequirement.HUMAN_CONFIRM
    assert verdict.rule == kind.value


_SPRAY_HEREDOC = (
    "cat > spray.py <<'PY_EOF'\n"
    "import json\n"
    "def deploy():\n"
    "    secret = 'token'\n"
    "    write_key(secret)\n"
    "PY_EOF\n"
)


@pytest.mark.parametrize(
    "command",
    [
        _SPRAY_HEREDOC,
        "cat > src/app.py <<'EOF'\nprint('ok')\nEOF\n",
        "cat >> notes.txt <<EOF\nhello\nEOF",
        "tee spray.py <<'PY_EOF'\nprint(1)\nPY_EOF",
        "cat > index.html <<'PY_EOF'\n<!DOCTYPE html>\nPY_EOF\necho done",
        "cat > index.html <<'EOF'\nhello\nEOF\ntrue\n",
        "python spray.py",
        "python3 ./main.py",
        "python src/app.py --port=8080",
    ],
)
def test_builder_preset_auto_approves_relative_workspace_writes(command: str) -> None:
    verdict = classify_action({"tool": "run_shell", "args": {"command": command}})

    assert verdict.destructiveness is Destructiveness.BENIGN
    assert verdict.required_gate is GateRequirement.AUTO_APPROVE
    assert verdict.rule == "builder-local-write"


@pytest.mark.parametrize(
    "command",
    [
        "cat > /etc/passwd <<'EOF'\nroot\nEOF",
        "cat > ../secrets.env <<'EOF'\nx=1\nEOF",
        "cat > ~/.ssh/authorized_keys <<'EOF'\nssh-rsa\nEOF",
        "cat > spray.py <<'PY_EOF'\nprint(1)\nPY_EOF\nrm -rf /",
        "cat > index.html <<'PY_EOF'\nhello\nPY_EOF\necho done && rm -rf /",
        "python -c \"import shutil; shutil.rmtree('.')\"",
        "python /tmp/evil.py",
        "python ../outside.py",
    ],
)
def test_builder_preset_still_gates_unsafe_or_chained_writes(command: str) -> None:
    verdict = classify_action({"tool": "run_shell", "args": {"command": command}})

    assert verdict.destructiveness is Destructiveness.DESTRUCTIVE
    assert verdict.required_gate is GateRequirement.HUMAN_CONFIRM


def test_strict_preset_still_gates_heredoc_writes() -> None:
    verdict = classify_action(
        {"tool": "run_shell", "args": {"command": _SPRAY_HEREDOC}},
        rule_set=STRICT_RULE_SET,
    )

    assert verdict.required_gate is GateRequirement.HUMAN_CONFIRM
    assert verdict.rule == "fail-closed"


def test_unknown_gate_preset_fails_closed_to_strict() -> None:
    assert rule_set_for_preset("not-a-real-preset") is STRICT_RULE_SET


def test_loopit_gate_preset_env_selects_strict(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("LOOPIT_GATE_PRESET", "strict")
    verdict = classify_action({"tool": "run_shell", "args": {"command": _SPRAY_HEREDOC}})

    assert verdict.required_gate is GateRequirement.HUMAN_CONFIRM
