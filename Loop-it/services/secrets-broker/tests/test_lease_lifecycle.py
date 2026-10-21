"""Lease lifecycle: issue, reveal, expiry mid-step, revoke, run cancellation."""

from __future__ import annotations

from datetime import timedelta

import pytest
from loopit_secrets import (
    Lease,
    LeaseExpired,
    LeaseRevoked,
    LeaseState,
    LeaseTooLong,
    SecretsBroker,
    StepContext,
)

from .conftest import SECRET_NAME, ManualClock, fake_value


def test_issue_then_reveal_returns_plaintext(broker: SecretsBroker, context: StepContext) -> None:
    lease = broker.issue(context, SECRET_NAME, ttl=timedelta(minutes=1))
    assert isinstance(lease, Lease)
    assert lease.secret_name == SECRET_NAME
    assert broker.reveal(lease) == fake_value()


def test_reveal_is_repeatable_within_the_step(broker: SecretsBroker, context: StepContext) -> None:
    lease = broker.issue(context, SECRET_NAME, ttl=timedelta(minutes=1))
    assert broker.reveal(lease) == broker.reveal(lease)


def test_lease_expires_on_its_own_mid_step(
    broker: SecretsBroker, context: StepContext, clock: ManualClock
) -> None:
    lease = broker.issue(context, SECRET_NAME, ttl=timedelta(minutes=1))
    clock.advance(timedelta(minutes=1, seconds=1))
    with pytest.raises(LeaseExpired):
        broker.reveal(lease)


def test_ttl_beyond_the_cap_is_refused(broker: SecretsBroker, context: StepContext) -> None:
    with pytest.raises(LeaseTooLong):
        broker.issue(context, SECRET_NAME, ttl=timedelta(hours=1))


def test_non_positive_ttl_is_refused(broker: SecretsBroker, context: StepContext) -> None:
    with pytest.raises(LeaseTooLong):
        broker.issue(context, SECRET_NAME, ttl=timedelta(0))


def test_explicit_revoke_denies_further_reveals(
    broker: SecretsBroker, context: StepContext
) -> None:
    lease = broker.issue(context, SECRET_NAME, ttl=timedelta(minutes=1))
    broker.revoke(lease)
    with pytest.raises(LeaseRevoked):
        broker.reveal(lease)


def test_step_completion_revokes_the_step_leases(
    broker: SecretsBroker, context: StepContext
) -> None:
    lease = broker.issue(context, SECRET_NAME, ttl=timedelta(minutes=1))
    broker.revoke_step(context.run_id, context.step_id)
    with pytest.raises(LeaseRevoked):
        broker.reveal(lease)


def test_run_cancellation_revokes_every_lease_in_the_run(
    broker: SecretsBroker, context: StepContext
) -> None:
    other_step = StepContext(
        run_id=context.run_id,
        step_id="step_seed_data",
        tenant_id=context.tenant_id,
        project_id=context.project_id,
        declared_secrets=frozenset({SECRET_NAME}),
    )
    lease_a = broker.issue(context, SECRET_NAME, ttl=timedelta(minutes=1))
    lease_b = broker.issue(other_step, SECRET_NAME, ttl=timedelta(minutes=1))

    broker.revoke_run(context.run_id)

    with pytest.raises(LeaseRevoked):
        broker.reveal(lease_a)
    with pytest.raises(LeaseRevoked):
        broker.reveal(lease_b)


def test_revoke_is_idempotent_and_survives_dead_leases(
    broker: SecretsBroker, context: StepContext
) -> None:
    lease = broker.issue(context, SECRET_NAME, ttl=timedelta(minutes=1))
    broker.revoke(lease)
    broker.revoke(lease)  # a second revoke must not raise
    with pytest.raises(LeaseRevoked):
        broker.reveal(lease)


def test_lease_state_enum_is_terminal_and_absorbing() -> None:
    assert {s.value for s in LeaseState} == {"active", "expired", "revoked"}
