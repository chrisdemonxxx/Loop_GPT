"""The lease — a capability, not a copy of the secret (Doc 06 §4, Doc 08 §5).

A lease is what the broker hands back when a step is allowed a secret. It is
deliberately *not* the secret: the plaintext lives only inside the broker, and
the lease is an immutable claim ticket that says "run R, step S, may read secret
N until time T". Every actual read goes back through the broker with this ticket,
which is what makes the grant revocable and self-expiring — properties a bare
copy of the value could never have, because once you have handed out the bytes
you cannot take them back.

The handle carries no value field at all, so it cannot leak one through ``repr``,
and it is frozen so a holder cannot quietly extend its own expiry or repoint it
at another step. State (active / expired / revoked) is tracked by the broker, not
here, so the ticket a caller holds can never disagree with the authority the
broker actually recognises.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from enum import Enum

from .environment import Environment


class LeaseState(Enum):
    """The lifecycle of a lease, owned and transitioned by the broker.

    A lease is born :attr:`ACTIVE`. It reaches exactly one terminal state:
    :attr:`EXPIRED` when its expiry passes, or :attr:`REVOKED` when a step
    finishes, a run is cancelled, or it is revoked explicitly. Terminal states
    are absorbing — a revoked lease never becomes active again, so a replayed id
    cannot resurrect access.
    """

    ACTIVE = "active"
    EXPIRED = "expired"
    REVOKED = "revoked"


@dataclass(frozen=True, slots=True)
class Lease:
    """An immutable, single-step claim on one secret name.

    Bound to a single run, step, tenant, project, and secret name, with an
    explicit expiry. Carries no plaintext: the value is never a field here, so a
    lease cannot leak a secret however it is logged or rendered.
    """

    lease_id: str
    secret_name: str
    environment: Environment
    run_id: str
    step_id: str
    tenant_id: str
    project_id: str
    issued_at: datetime
    expires_at: datetime
