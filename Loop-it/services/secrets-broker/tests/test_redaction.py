"""Values never surface in a repr, an audit record, or an error message."""

from __future__ import annotations

import json
from datetime import timedelta

import pytest
from loopit_agent_core.audit import InMemoryAuditSink
from loopit_secrets import (
    LeaseExpired,
    SecretsBroker,
    SecretValue,
    StepContext,
)

from .conftest import SECRET_NAME, ManualClock, fake_value


def test_secret_value_repr_and_str_are_redacted() -> None:
    secret = fake_value("leaky")
    wrapped = SecretValue(secret)
    assert secret not in repr(wrapped)
    assert secret not in str(wrapped)
    assert wrapped.reveal() == secret


def test_lease_handle_repr_never_carries_the_value(
    broker: SecretsBroker, context: StepContext
) -> None:
    lease = broker.issue(context, SECRET_NAME, ttl=timedelta(minutes=1))
    assert fake_value() not in repr(lease)
    assert fake_value() not in str(lease)


def test_audit_trail_references_names_not_values(
    broker: SecretsBroker, context: StepContext, audit: InMemoryAuditSink
) -> None:
    lease = broker.issue(context, SECRET_NAME, ttl=timedelta(minutes=1))
    broker.reveal(lease)
    broker.revoke(lease)

    serialised = json.dumps([event.to_dict() for event in audit.events])
    assert fake_value() not in serialised
    assert SECRET_NAME in serialised  # the name is present; the value is not
    assert lease.lease_id in serialised


def test_denials_and_errors_do_not_leak_the_value(
    broker: SecretsBroker, context: StepContext, clock: ManualClock, audit: InMemoryAuditSink
) -> None:
    lease = broker.issue(context, SECRET_NAME, ttl=timedelta(minutes=1))
    clock.advance(timedelta(minutes=2))
    with pytest.raises(LeaseExpired) as excinfo:
        broker.reveal(lease)

    assert fake_value() not in str(excinfo.value)
    serialised = json.dumps([event.to_dict() for event in audit.events])
    assert fake_value() not in serialised
