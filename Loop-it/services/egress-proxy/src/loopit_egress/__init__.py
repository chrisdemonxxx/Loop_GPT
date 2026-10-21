"""Default-deny egress policy engine.

Egress control is the single highest-leverage security measure in the platform
(Doc 02 §5). It neutralises exfiltration, command-and-control, and
abuse-as-a-service at once, and it is worth more than the choice of sandbox
runtime. Monitoring without blocking is how you learn about the botnet from the
abuse report.

Two rules are structural and not configurable:

* **I3** — the default action is ``deny``. There is no allow-all posture.
* **I4** — link-local and cloud metadata ranges are *always* denied, and cannot
  be re-enabled by any policy, category, or per-project allowlist.
"""

from .denylist import MINING_POOL_DOMAINS, STRATUM_PORTS, mining_denial
from .policy import (
    ALWAYS_DENIED_NETWORKS,
    Category,
    Decision,
    EgressPolicy,
    PolicyError,
    Verdict,
)
from .proxy import (
    DEFAULT_EGRESS_BYTE_BUDGET,
    EgressProxy,
    EgressRequest,
    LeaseUsage,
    PolicyResolver,
    StaticPolicyResolver,
)
from .registries import DEFAULT_REGISTRY_DOMAINS

__all__ = [
    "ALWAYS_DENIED_NETWORKS",
    "DEFAULT_EGRESS_BYTE_BUDGET",
    "DEFAULT_REGISTRY_DOMAINS",
    "MINING_POOL_DOMAINS",
    "STRATUM_PORTS",
    "Category",
    "Decision",
    "EgressPolicy",
    "EgressProxy",
    "EgressRequest",
    "LeaseUsage",
    "PolicyError",
    "PolicyResolver",
    "StaticPolicyResolver",
    "Verdict",
    "mining_denial",
]
