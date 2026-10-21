"""Platform-owned classes are refused at both the store and the request."""

from __future__ import annotations

from datetime import timedelta

import pytest
from loopit_secrets import (
    Environment,
    PlatformSecretForbidden,
    SecretClass,
    SecretsBroker,
    SecretStore,
    SecretValue,
    StepContext,
    StoredSecret,
)

from .conftest import PROJECT, TENANT, fake_value


def test_store_refuses_a_model_key_at_insert() -> None:
    """A project store physically cannot hold a model key (I5, Doc 06 §4.1)."""
    store = SecretStore(Environment.BUILD)
    with pytest.raises(PlatformSecretForbidden):
        store.put(
            StoredSecret(
                name="ROUTER_UPSTREAM_KEY",
                environment=Environment.BUILD,
                secret_class=SecretClass.MODEL_KEY,
                tenant_id=TENANT,
                project_id=PROJECT,
                value=SecretValue(fake_value("model")),
            )
        )


def test_store_refuses_cross_tenant_and_admin_classes() -> None:
    store = SecretStore(Environment.BUILD)
    for cls in (
        SecretClass.CLOUD_CREDENTIAL,
        SecretClass.DB_ADMIN,
        SecretClass.FOREIGN_TENANT,
    ):
        with pytest.raises(PlatformSecretForbidden):
            store.put(
                StoredSecret(
                    name=f"X_{cls.value}",
                    environment=Environment.BUILD,
                    secret_class=cls,
                    tenant_id=TENANT,
                    project_id=PROJECT,
                    value=SecretValue(fake_value(cls.value)),
                )
            )


def test_reserved_platform_name_is_refused_even_if_declared(broker: SecretsBroker) -> None:
    """Declaring a platform name does not help — the request boundary refuses it,
    so a project step cannot ask for a model key at all."""
    context = StepContext(
        run_id="run_1",
        step_id="step_x",
        tenant_id=TENANT,
        project_id=PROJECT,
        declared_secrets=frozenset({"OPENAI_API_KEY"}),
    )
    with pytest.raises(PlatformSecretForbidden):
        broker.issue(context, "OPENAI_API_KEY", ttl=timedelta(minutes=1))
