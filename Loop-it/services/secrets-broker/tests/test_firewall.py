"""The build↔prod firewall is structural: a build broker cannot reach prod."""

from __future__ import annotations

from datetime import timedelta

import pytest
from loopit_agent_core.audit import InMemoryAuditSink
from loopit_secrets import (
    Environment,
    EnvironmentMismatch,
    SecretClass,
    SecretNotFound,
    SecretsBroker,
    SecretStore,
    SecretValue,
    StepContext,
    StoredSecret,
)

from .conftest import PROJECT, SECRET_NAME, TENANT, ManualClock, fake_value


def _prod_store_with_secret() -> SecretStore:
    store = SecretStore(Environment.PROD)
    store.put(
        StoredSecret(
            name=SECRET_NAME,
            environment=Environment.PROD,
            secret_class=SecretClass.PROJECT,
            tenant_id=TENANT,
            project_id=PROJECT,
            value=SecretValue(fake_value("prod")),
        )
    )
    return store


def test_build_broker_serves_only_its_environment(broker: SecretsBroker) -> None:
    assert broker.environment is Environment.BUILD


def test_build_broker_cannot_resolve_a_prod_secret(
    audit: InMemoryAuditSink, clock: ManualClock
) -> None:
    """A prod project secret exists, and the build broker still cannot see it.

    There is no API on the broker that accepts an environment, so this is the
    only way to even attempt the crossing — and it fails closed because the build
    store simply does not contain the prod secret.
    """
    build_store = SecretStore(Environment.BUILD)
    build_broker = SecretsBroker(build_store, audit=audit, clock=clock)
    _prod_store_with_secret()  # the prod secret exists, in a separate partition

    context = StepContext(
        run_id="run_1",
        step_id="step_x",
        tenant_id=TENANT,
        project_id=PROJECT,
        declared_secrets=frozenset({SECRET_NAME}),
    )
    with pytest.raises(SecretNotFound):
        build_broker.issue(context, SECRET_NAME, ttl=timedelta(minutes=1))

    denied = audit.of_type("secret.lease.denied")
    assert denied and denied[-1].detail["reason"] == "not_found"


def test_store_refuses_a_secret_of_another_environment() -> None:
    build_store = SecretStore(Environment.BUILD)
    with pytest.raises(EnvironmentMismatch):
        build_store.put(
            StoredSecret(
                name=SECRET_NAME,
                environment=Environment.PROD,
                secret_class=SecretClass.PROJECT,
                tenant_id=TENANT,
                project_id=PROJECT,
                value=SecretValue(fake_value()),
            )
        )
