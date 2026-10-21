from __future__ import annotations

import importlib.util
from pathlib import Path

_module_path = Path(__file__).resolve().parents[3] / "scripts" / "selfhost_preflight.py"
_spec = importlib.util.spec_from_file_location("selfhost_preflight", _module_path)
assert _spec is not None and _spec.loader is not None
preflight = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(preflight)

REQUIRED = preflight.REQUIRED
REQUIRED_SECRETS = preflight.REQUIRED_SECRETS
check = preflight.check
main = preflight.main


def _strong(length: int) -> str:
    """A non-placeholder secret of the requested length, for fixtures."""
    alphabet = "aB3xK9mQ7pL2wR5tY8uI1oP4sD6fG0hJnZvCzX"
    return (alphabet * (length // len(alphabet) + 1))[:length]


def test_preflight_reports_missing_required_config() -> None:
    missing, warnings, invalid = check({})
    assert set(missing) == {
        *REQUIRED,
        *REQUIRED_SECRETS,
        *preflight.REQUIRED_BASE64_32_BYTE_SECRETS,
    }
    assert warnings
    assert invalid == []


def test_preflight_accepts_complete_config() -> None:
    env = {name: "configured" for name in REQUIRED}
    env.update({name: _strong(minimum) for name, minimum in REQUIRED_SECRETS.items()})
    missing, _, invalid = check(env)
    assert missing == []
    assert invalid == []


def test_preflight_rejects_placeholder_and_short_secrets() -> None:
    env = {name: "configured" for name in REQUIRED}
    env.update({name: _strong(minimum) for name, minimum in REQUIRED_SECRETS.items()})
    env["LOOPIT_IDENTITY_SECRET"] = "dev-identity-key-change-me"
    env["LOOPIT_SERVICE_TOKEN"] = "short"

    _missing, _warnings, invalid = check(env)

    assert any("LOOPIT_IDENTITY_SECRET must not use a placeholder" in issue for issue in invalid)
    assert any("LOOPIT_SERVICE_TOKEN must be at least 32" in issue for issue in invalid)


def test_preflight_rejects_abuse_dry_run_for_production() -> None:
    env = {name: "configured" for name in REQUIRED}
    env.update({name: _strong(minimum) for name, minimum in REQUIRED_SECRETS.items()})
    env["LOOPIT_ABUSE_DRY_RUN"] = "1"

    _missing, _warnings, invalid = check(env)

    assert "LOOPIT_ABUSE_DRY_RUN must be 0/false for production enforcement" in invalid


def test_preflight_rejects_dev_single_tenant_in_prod() -> None:
    env = {name: "configured" for name in REQUIRED}
    env.update({name: _strong(minimum) for name, minimum in REQUIRED_SECRETS.items()})
    env["LOOPIT_ENV"] = "prod"
    env["LOOPIT_DEV_SINGLE_TENANT"] = "1"

    _missing, _warnings, invalid = check(env)

    assert "LOOPIT_DEV_SINGLE_TENANT must be unset/0 for production auth" in invalid


def test_preflight_rejects_dev_single_tenant_with_non_local_store() -> None:
    env = {name: "configured" for name in REQUIRED}
    env.update({name: _strong(minimum) for name, minimum in REQUIRED_SECRETS.items()})
    env["LOOPIT_STORE_DSN"] = "postgresql://loopit@db.example.com:5432/loopit"
    env["LOOPIT_DEV_SINGLE_TENANT"] = "true"

    _missing, _warnings, invalid = check(env)

    assert "LOOPIT_DEV_SINGLE_TENANT must be unset/0 for production auth" in invalid


def test_preflight_rejects_dev_single_tenant_when_environment_is_unset() -> None:
    env = {name: "configured" for name in REQUIRED}
    env.update({name: _strong(minimum) for name, minimum in REQUIRED_SECRETS.items()})
    env["LOOPIT_ENV"] = ""
    env["LOOPIT_PUBLIC_URL"] = "http://localhost:8080"
    env["LOOPIT_POSTGRES_DSN"] = "postgresql://loopit@127.0.0.1:5432/loopit"
    env["LOOPIT_STORE_DSN"] = "postgresql://loopit@127.0.0.1:5432/loopit"
    env["LOOPIT_DEV_SINGLE_TENANT"] = "1"

    _missing, _warnings, invalid = check(env)

    assert "LOOPIT_DEV_SINGLE_TENANT must be unset/0 for production auth" in invalid


def test_preflight_rejects_dev_single_tenant_with_public_url_and_local_db() -> None:
    """Single-VM self-host: public origin but loopback Postgres must still count as prod."""
    env = {name: "configured" for name in REQUIRED}
    env.update({name: _strong(minimum) for name, minimum in REQUIRED_SECRETS.items()})
    env["LOOPIT_PUBLIC_URL"] = "https://loopit.example.com"
    env["LOOPIT_POSTGRES_DSN"] = "postgresql://loopit@127.0.0.1:5432/loopit"
    env["LOOPIT_DEV_SINGLE_TENANT"] = "1"

    _missing, _warnings, invalid = check(env)

    assert "LOOPIT_DEV_SINGLE_TENANT must be unset/0 for production auth" in invalid


def test_preflight_rejects_ephemeral_audit() -> None:
    env = {name: "configured" for name in REQUIRED}
    env.update({name: _strong(minimum) for name, minimum in REQUIRED_SECRETS.items()})
    env["LOOPIT_AUDIT_EPHEMERAL"] = "1"

    _missing, _warnings, invalid = check(env)

    assert "LOOPIT_AUDIT_EPHEMERAL must be unset/0 so edge audit records persist" in invalid


def test_preflight_rejects_placeholder_audit_dsn() -> None:
    env = {name: "configured" for name in REQUIRED}
    env.update({name: _strong(minimum) for name, minimum in REQUIRED_SECRETS.items()})
    env["LOOPIT_AUDIT_DSN"] = "changeme"

    _missing, _warnings, invalid = check(env)

    assert "LOOPIT_AUDIT_DSN must not use a placeholder value" in invalid
