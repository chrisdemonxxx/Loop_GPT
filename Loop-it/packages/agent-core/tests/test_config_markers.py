"""Production-marker semantics shared by the API guard and the self-host preflight.

``has_production_marker`` is the single gate standing between a live deployment and
``LOOPIT_DEV_SINGLE_TENANT``, which bypasses authentication entirely. It must be
fail-closed: an unrecognised ``LOOPIT_ENV`` counts as production.
"""

from __future__ import annotations

import pytest
from loopit_agent_core.config import (
    NON_PRODUCTION_ENVIRONMENTS,
    has_production_marker,
    is_truthy,
)


@pytest.mark.parametrize(
    "environment",
    ["prod", "production", "PRODUCTION", "live", "staging", "prod-eu", "anything-else"],
)
def test_unrecognised_environment_names_are_production(environment: str) -> None:
    assert has_production_marker({"LOOPIT_ENV": environment}) is True


@pytest.mark.parametrize("environment", ["test", "ci"])
def test_shared_test_and_ci_environment_names_are_production(environment: str) -> None:
    assert has_production_marker({"LOOPIT_ENV": environment}) is True


@pytest.mark.parametrize("environment", sorted(NON_PRODUCTION_ENVIRONMENTS))
def test_known_development_environments_are_not_production(environment: str) -> None:
    assert has_production_marker({"LOOPIT_ENV": environment}) is False
    assert has_production_marker({"LOOPIT_ENV": environment.upper()}) is False


def test_empty_environment_is_a_production_marker() -> None:
    assert has_production_marker({}) is True
    assert has_production_marker({"LOOPIT_ENV": "   "}) is True


def test_non_local_public_url_is_a_marker() -> None:
    assert (
        has_production_marker(
            {"LOOPIT_ENV": "dev", "LOOPIT_PUBLIC_URL": "https://loopit.example.com"}
        )
        is True
    )
    assert (
        has_production_marker({"LOOPIT_ENV": "dev", "LOOPIT_PUBLIC_URL": "http://localhost:8080"})
        is False
    )
    assert (
        has_production_marker({"LOOPIT_ENV": "dev", "LOOPIT_PUBLIC_URL": "http://127.0.0.1:8080"})
        is False
    )


@pytest.mark.parametrize("name", ["LOOPIT_STORE_DSN", "LOOPIT_POSTGRES_DSN", "DATABASE_URL"])
def test_non_local_dsn_is_a_marker(name: str) -> None:
    assert (
        has_production_marker({"LOOPIT_ENV": "dev", name: "postgresql://db.internal:5432/loopit"})
        is True
    )
    assert (
        has_production_marker({"LOOPIT_ENV": "dev", name: "postgresql://localhost:5432/loopit"})
        is False
    )


def test_unknown_dsn_host_is_a_marker() -> None:
    assert (
        has_production_marker({"LOOPIT_ENV": "dev", "LOOPIT_STORE_DSN": "postgresql:///loopit"})
        is True
    )
    assert has_production_marker({"LOOPIT_ENV": "dev", "LOOPIT_STORE_DSN": "not a url"}) is True


def test_libpq_keyword_dsn_host_is_detected() -> None:
    assert (
        has_production_marker(
            {
                "LOOPIT_ENV": "dev",
                "LOOPIT_STORE_DSN": (
                    "host=db.prod.internal user=app password=opaquevalue dbname=loopit"
                ),
            }
        )
        is True
    )
    assert (
        has_production_marker(
            {"LOOPIT_ENV": "dev", "LOOPIT_STORE_DSN": "host=localhost user=app dbname=loopit"}
        )
        is False
    )


def test_localhost_dsn_with_production_env_still_flags() -> None:
    """A localhost pgbouncer sidecar is a real production topology.

    The DSN looks local, so ``LOOPIT_ENV`` is the only signal available.
    """

    env = {
        "LOOPIT_ENV": "production",
        "LOOPIT_STORE_DSN": "postgresql://u:p@localhost:6432/loopit",
        "LOOPIT_PUBLIC_URL": "http://localhost:8080",
    }
    assert has_production_marker(env) is True


@pytest.mark.parametrize("value", ["1", "true", "TRUE", "yes", "on"])
def test_is_truthy_accepts_common_affirmatives(value: str) -> None:
    assert is_truthy(value) is True


@pytest.mark.parametrize("value", [None, "", "0", "false", "no", "off", "maybe"])
def test_is_truthy_rejects_everything_else(value: str | None) -> None:
    assert is_truthy(value) is False
