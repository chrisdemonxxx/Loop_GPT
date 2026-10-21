"""Connector credentials stay inside a request-scoped lease.

The broker records the plaintext only on the lease. reveal returns it to the
caller and does not write os.environ. request_scope revokes the lease when the
request ends; revoke_run still covers a cancelled run.
"""

from __future__ import annotations

import os
from datetime import timedelta

import pytest
from loopit_secrets import Lease, LeaseExpired, LeaseRevoked, SecretsBroker, StepContext

from .conftest import SECRET_NAME, ManualClock, fake_value


def test_request_scope_never_puts_the_secret_in_the_environment(
    broker: SecretsBroker, context: StepContext
) -> None:
    before = os.environ.copy()
    with broker.request_scope(context) as issue:
        lease = issue(SECRET_NAME, ttl=timedelta(minutes=1))
        revealed = broker.reveal(lease)
        assert lease.run_id == context.run_id
        assert lease.step_id == context.step_id
        assert revealed == fake_value()
        assert revealed not in os.environ.values()
        assert os.environ.copy() == before
    with pytest.raises(LeaseRevoked):
        broker.reveal(lease)
    assert revealed not in os.environ.values()
    assert os.environ.copy() == before


def test_request_scope_revokes_leases_when_the_caller_fails(
    broker: SecretsBroker, context: StepContext
) -> None:
    held: list[Lease] = []
    with pytest.raises(RuntimeError, match="step failed"):
        with broker.request_scope(context) as issue:
            held.append(issue(SECRET_NAME, ttl=timedelta(seconds=30)))
            raise RuntimeError("step failed")
    with pytest.raises(LeaseRevoked):
        broker.reveal(held[0])


def test_revoke_run_still_expires_a_lease_that_outlives_one_step(
    broker: SecretsBroker, context: StepContext, clock: ManualClock
) -> None:
    lease = broker.issue(context, SECRET_NAME, ttl=timedelta(minutes=1))
    broker.revoke_run(context.run_id)
    with pytest.raises(LeaseRevoked):
        broker.reveal(lease)
    clock.advance(timedelta(minutes=2))
    with pytest.raises(LeaseRevoked):
        broker.reveal(lease)
    assert fake_value() not in os.environ.values()


def test_expired_lease_is_not_copied_out_to_the_environment(
    broker: SecretsBroker, context: StepContext, clock: ManualClock
) -> None:
    before = os.environ.copy()
    lease = broker.issue(context, SECRET_NAME, ttl=timedelta(seconds=30))
    clock.advance(timedelta(seconds=31))
    with pytest.raises(LeaseExpired):
        broker.reveal(lease)
    assert os.environ.copy() == before
