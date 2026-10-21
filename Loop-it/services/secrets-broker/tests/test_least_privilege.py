"""Least privilege: a step leases only names it declared; nothing broadcasts."""

from __future__ import annotations

from datetime import timedelta

import pytest
from loopit_secrets import SecretsBroker, StepContext, UndeclaredSecret

from .conftest import PROJECT, SECRET_NAME, TENANT


def test_undeclared_name_is_denied_and_audited(broker: SecretsBroker) -> None:
    context = StepContext(
        run_id="run_1",
        step_id="step_x",
        tenant_id=TENANT,
        project_id=PROJECT,
        declared_secrets=frozenset(),  # the step declared nothing
    )
    with pytest.raises(UndeclaredSecret):
        broker.issue(context, SECRET_NAME, ttl=timedelta(minutes=1))


def test_declaring_one_name_does_not_grant_another(broker: SecretsBroker) -> None:
    context = StepContext(
        run_id="run_1",
        step_id="step_x",
        tenant_id=TENANT,
        project_id=PROJECT,
        declared_secrets=frozenset({"SOME_OTHER_KEY"}),
    )
    with pytest.raises(UndeclaredSecret):
        broker.issue(context, SECRET_NAME, ttl=timedelta(minutes=1))


def test_there_is_no_give_me_everything_path(broker: SecretsBroker) -> None:
    """The public surface exposes no wildcard/all-secrets accessor."""
    surface = set(dir(broker))
    for forbidden in ("all", "all_secrets", "dump", "list_secrets", "everything"):
        assert forbidden not in surface
