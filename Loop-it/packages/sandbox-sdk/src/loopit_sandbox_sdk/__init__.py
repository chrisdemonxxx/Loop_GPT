"""The control-plane ↔ sandbox channel.

Trust across this boundary is **one-directional** (Doc 06 §1): the control plane
issues narrow, scoped instructions and the sandbox returns structured results.
The sandbox cannot call arbitrary control-plane endpoints, cannot widen its own
lease, and holds no ambient credentials (invariant I2).

Every instruction is signed and bound to a single lease, a single tenant, and a
single expiry, so a captured envelope cannot be replayed into another tenant's
sandbox or after the lease ends.
"""

from .browser import (
    BrowserDriver,
    BrowserError,
    BrowserTool,
    ConsoleMessage,
    DisallowedTarget,
    NavigationTimeout,
    NetworkFailure,
    PageResult,
)
from .envelope import (
    ChannelError,
    Envelope,
    ExpiredEnvelopeError,
    LeaseMismatchError,
    ReplayError,
    SignatureError,
    derive_lease_signing_key,
    sign,
    verify,
)
from .flows import (
    CRITICAL_FLOWS,
    Click,
    Credentials,
    ExpectAbsent,
    ExpectText,
    Fill,
    Flow,
    FlowDriver,
    FlowError,
    FlowResult,
    Step,
    StepOutcome,
    Visit,
    run_flow,
    signup_login_create_readback,
    tenant_isolation_flow,
)
from .lease import Lease, ResourceCaps

__all__ = [
    "CRITICAL_FLOWS",
    "BrowserDriver",
    "BrowserError",
    "BrowserTool",
    "ChannelError",
    "Click",
    "ConsoleMessage",
    "Credentials",
    "DisallowedTarget",
    "Envelope",
    "ExpectAbsent",
    "ExpectText",
    "ExpiredEnvelopeError",
    "Fill",
    "Flow",
    "FlowDriver",
    "FlowError",
    "FlowResult",
    "Lease",
    "LeaseMismatchError",
    "NavigationTimeout",
    "NetworkFailure",
    "PageResult",
    "ReplayError",
    "ResourceCaps",
    "SignatureError",
    "Step",
    "StepOutcome",
    "Visit",
    "derive_lease_signing_key",
    "run_flow",
    "sign",
    "signup_login_create_readback",
    "tenant_isolation_flow",
    "verify",
]
