"""Tests for the signed control-plane ↔ sandbox channel.

Guards the one-directional trust boundary from Doc 06 §1 and the lease
discipline from Doc 02 §2.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from loopit_sandbox_sdk import (
    Envelope,
    ExpiredEnvelopeError,
    Lease,
    LeaseMismatchError,
    ReplayError,
    ResourceCaps,
    SignatureError,
    derive_lease_signing_key,
    sign,
    verify,
)
from loopit_sandbox_sdk.lease import LeaseError

KEY = b"unit-test-signing-key"
OTHER_KEY = b"a-different-signing-key"


def make_lease(**overrides: object) -> Lease:
    defaults: dict[str, object] = {
        "lease_id": "lease_1",
        "tenant_id": "tenant_a",
        "run_id": "run_1",
        "base_checkpoint_id": "ckpt_0",
        "ttl_seconds": 600,
    }
    return Lease.issue(**{**defaults, **overrides})  # type: ignore[arg-type]


def make_envelope(lease: Lease, tool: str = "run_shell", **overrides: object) -> Envelope:
    defaults: dict[str, object] = {
        "lease_id": lease.lease_id,
        "tenant_id": lease.tenant_id,
        "run_id": lease.run_id,
        "tool": tool,
        "args": {"command": "pnpm test"},
    }
    return Envelope(**{**defaults, **overrides})  # type: ignore[arg-type]


# --- Signing ------------------------------------------------------------------


def test_a_signed_envelope_verifies() -> None:
    lease = make_lease()
    envelope = sign(make_envelope(lease), KEY)
    verify(envelope, KEY, lease)  # does not raise


def test_an_unsigned_envelope_is_rejected() -> None:
    lease = make_lease()
    with pytest.raises(SignatureError, match="unsigned"):
        verify(make_envelope(lease), KEY, lease)


def test_a_wrong_key_does_not_verify() -> None:
    lease = make_lease()
    envelope = sign(make_envelope(lease), KEY)
    with pytest.raises(SignatureError):
        verify(envelope, OTHER_KEY, lease)


def test_lease_signing_keys_are_derived_per_lease() -> None:
    root = b"root-signing-key-with-at-least-thirty-two-bytes"
    lease = make_lease()
    sibling = make_lease(lease_id="lease_2")

    lease_key = derive_lease_signing_key(root, lease)
    sibling_key = derive_lease_signing_key(root, sibling)

    assert len(lease_key) == 32
    assert lease_key != sibling_key
    envelope = sign(make_envelope(lease), lease_key)
    verify(envelope, lease_key, lease)
    with pytest.raises(SignatureError):
        verify(envelope, sibling_key, lease)


def test_tampering_with_the_args_breaks_the_signature() -> None:
    lease = make_lease()
    signed = sign(make_envelope(lease), KEY)
    tampered = Envelope(
        lease_id=signed.lease_id,
        tenant_id=signed.tenant_id,
        run_id=signed.run_id,
        tool=signed.tool,
        args={"command": "curl http://169.254.169.254/"},
        nonce=signed.nonce,
        issued_at=signed.issued_at,
        expires_at=signed.expires_at,
        signature=signed.signature,
    )
    with pytest.raises(SignatureError):
        verify(tampered, KEY, lease)


def test_tampering_with_the_expiry_breaks_the_signature() -> None:
    lease = make_lease()
    signed = sign(make_envelope(lease), KEY)
    extended = Envelope(
        lease_id=signed.lease_id,
        tenant_id=signed.tenant_id,
        run_id=signed.run_id,
        tool=signed.tool,
        args=signed.args,
        nonce=signed.nonce,
        issued_at=signed.issued_at,
        expires_at=signed.expires_at + timedelta(days=365),
        signature=signed.signature,
    )
    with pytest.raises(SignatureError):
        verify(extended, KEY, lease)


def test_argument_order_does_not_change_the_signature() -> None:
    lease = make_lease()
    one = sign(make_envelope(lease, args={"a": 1, "b": 2}), KEY)
    two = Envelope(
        lease_id=one.lease_id,
        tenant_id=one.tenant_id,
        run_id=one.run_id,
        tool=one.tool,
        args={"b": 2, "a": 1},
        nonce=one.nonce,
        issued_at=one.issued_at,
        expires_at=one.expires_at,
    )
    assert sign(two, KEY).signature == one.signature


def test_signing_requires_a_key() -> None:
    with pytest.raises(SignatureError, match="empty"):
        sign(make_envelope(make_lease()), b"")


# --- Cross-tenant and cross-lease binding ------------------------------------


def test_an_envelope_cannot_be_replayed_into_another_tenants_sandbox() -> None:
    victim = make_lease(lease_id="lease_2", tenant_id="tenant_b", run_id="run_2")
    attacker_envelope = sign(make_envelope(make_lease()), KEY)

    with pytest.raises(LeaseMismatchError):
        verify(attacker_envelope, KEY, victim)


def test_an_envelope_bound_to_another_run_is_rejected() -> None:
    lease = make_lease()
    envelope = sign(make_envelope(lease, run_id="run_99"), KEY)
    with pytest.raises(LeaseMismatchError, match="run"):
        verify(envelope, KEY, lease)


# --- Expiry -------------------------------------------------------------------


def test_an_expired_envelope_is_rejected() -> None:
    lease = make_lease()
    envelope = sign(make_envelope(lease, expires_at=datetime.now(UTC) - timedelta(seconds=1)), KEY)
    with pytest.raises(ExpiredEnvelopeError, match="envelope has expired"):
        verify(envelope, KEY, lease)


def test_a_valid_envelope_against_an_expired_lease_is_rejected() -> None:
    """An envelope that is still fresh cannot outlive the lease it is bound to."""
    lease = make_lease()
    envelope = sign(make_envelope(lease, expires_at=lease.expires_at + timedelta(hours=1)), KEY)
    later = lease.expires_at + timedelta(seconds=1)
    with pytest.raises(ExpiredEnvelopeError, match="lease"):
        verify(envelope, KEY, lease, now=later)


# --- Replay -------------------------------------------------------------------


def test_an_envelope_is_single_use() -> None:
    lease = make_lease()
    envelope = sign(make_envelope(lease), KEY)
    seen: set[str] = set()

    verify(envelope, KEY, lease, seen_nonces=seen)
    with pytest.raises(ReplayError):
        verify(envelope, KEY, lease, seen_nonces=seen)


# --- Least-privilege tool surface --------------------------------------------


def test_a_tool_outside_the_lease_surface_is_rejected() -> None:
    lease = make_lease(allowed_tools=frozenset({"read_file"}))
    envelope = sign(make_envelope(lease, tool="run_shell"), KEY)
    with pytest.raises(LeaseMismatchError, match="tool surface"):
        verify(envelope, KEY, lease)


def test_deploy_can_never_be_part_of_a_build_lease() -> None:
    with pytest.raises(LeaseError, match="deploy is never part of a build lease"):
        make_lease(allowed_tools=frozenset({"run_shell", "deploy"}))


def test_the_default_lease_surface_excludes_deploy_and_provision() -> None:
    lease = make_lease()
    assert lease.permits("run_shell")
    assert not lease.permits("deploy")
    assert not lease.permits("provision")


# --- Lease discipline ---------------------------------------------------------


def test_a_lease_always_has_an_expiry() -> None:
    assert make_lease().expires_at > datetime.now(UTC)


def test_a_lease_requires_a_timezone_aware_expiry() -> None:
    with pytest.raises(LeaseError, match="timezone-aware"):
        Lease(
            lease_id="l",
            tenant_id="t",
            run_id="r",
            base_checkpoint_id="c",
            expires_at=datetime(2030, 1, 1),
        )


def test_a_lease_requires_a_base_checkpoint() -> None:
    with pytest.raises(LeaseError, match="base_checkpoint_id"):
        make_lease(base_checkpoint_id="")


@pytest.mark.parametrize(
    "field_name",
    ["cpu_millicores", "memory_mib", "disk_mib", "wall_clock_seconds", "max_processes"],
)
def test_resource_caps_must_be_positive(field_name: str) -> None:
    with pytest.raises(LeaseError, match="must be positive"):
        ResourceCaps(**{field_name: 0})


def test_resource_caps_have_bounded_defaults() -> None:
    caps = ResourceCaps()
    assert caps.wall_clock_seconds > 0
    assert caps.memory_mib > 0
    assert caps.max_processes > 0
