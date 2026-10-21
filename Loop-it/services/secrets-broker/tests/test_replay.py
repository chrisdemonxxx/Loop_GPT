"""Replay defences: forged ids, dead leases, and cross-step handle reuse."""

from __future__ import annotations

import dataclasses
from datetime import timedelta

import pytest
from loopit_secrets import (
    Environment,
    Lease,
    LeaseMismatch,
    LeaseRevoked,
    SecretsBroker,
    StepContext,
    UnknownLease,
)

from .conftest import SECRET_NAME


def test_forged_lease_id_is_rejected(broker: SecretsBroker) -> None:
    forged = Lease(
        lease_id="lease_deadbeef",
        secret_name=SECRET_NAME,
        environment=Environment.BUILD,
        run_id="run_1",
        step_id="step_x",
        tenant_id="tenant_alpha",
        project_id="project_gamma",
        issued_at=broker._clock(),
        expires_at=broker._clock() + timedelta(minutes=1),
    )
    with pytest.raises(UnknownLease):
        broker.reveal(forged)


def test_handle_tampered_to_claim_another_step_is_rejected(
    broker: SecretsBroker, context: StepContext
) -> None:
    """A captured ticket edited to name a different step must not authorise."""
    lease = broker.issue(context, SECRET_NAME, ttl=timedelta(minutes=1))
    replayed = dataclasses.replace(lease, step_id="step_someone_elses")
    with pytest.raises(LeaseMismatch):
        broker.reveal(replayed)


def test_revoked_lease_id_cannot_be_replayed(broker: SecretsBroker, context: StepContext) -> None:
    lease = broker.issue(context, SECRET_NAME, ttl=timedelta(minutes=1))
    assert broker.reveal(lease)  # worked once
    broker.revoke(lease)
    with pytest.raises(LeaseRevoked):
        broker.reveal(lease)
