"""Shared fixtures for the secrets-broker suite.

Fake secret values are assembled at runtime rather than written as literals: a
realistic-looking credential in a test file would trip the committed-secret
guard in ``scripts/check_invariants.py`` (I2), and the point of the suite is to
prove values never escape, not to smuggle one in.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from loopit_agent_core.audit import InMemoryAuditSink
from loopit_secrets import (
    Environment,
    SecretClass,
    SecretsBroker,
    SecretStore,
    SecretValue,
    StepContext,
    StoredSecret,
)

TENANT = "tenant_alpha"
PROJECT = "project_gamma"
RUN = "run_1"
STEP = "step_deploy_migration"
SECRET_NAME = "STRIPE_TEST_KEY"


def fake_value(marker: str = "canary") -> str:
    """Assemble a unique, non-literal fake secret value at runtime."""
    return "tok" + "_" + marker + "_" + "x" * 24


class ManualClock:
    """A clock the tests advance by hand to exercise expiry deterministically."""

    def __init__(self, start: datetime | None = None) -> None:
        self._now = start or datetime(2026, 1, 1, tzinfo=UTC)

    def __call__(self) -> datetime:
        return self._now

    def advance(self, delta: timedelta) -> None:
        self._now += delta


@pytest.fixture
def audit() -> InMemoryAuditSink:
    return InMemoryAuditSink()


@pytest.fixture
def clock() -> ManualClock:
    return ManualClock()


@pytest.fixture
def build_store() -> SecretStore:
    store = SecretStore(Environment.BUILD)
    store.put(
        StoredSecret(
            name=SECRET_NAME,
            environment=Environment.BUILD,
            secret_class=SecretClass.PROJECT,
            tenant_id=TENANT,
            project_id=PROJECT,
            value=SecretValue(fake_value()),
        )
    )
    return store


@pytest.fixture
def broker(build_store: SecretStore, audit: InMemoryAuditSink, clock: ManualClock) -> SecretsBroker:
    return SecretsBroker(build_store, audit=audit, clock=clock)


@pytest.fixture
def context() -> StepContext:
    return StepContext(
        run_id=RUN,
        step_id=STEP,
        tenant_id=TENANT,
        project_id=PROJECT,
        declared_secrets=frozenset({SECRET_NAME}),
    )
