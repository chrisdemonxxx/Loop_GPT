"""The model router — the only path from a sandbox to a model (invariant I5).

Three jobs, none of which the harness may do for itself:

1. **Credential injection is server-side.** The sandbox never holds a model API
   key, so a sandbox escape yields no key to steal. This is what makes open
   model choice safe rather than reckless (Doc 03 §0).
2. **Quota is enforced before spend.** A tenant over budget is refused *before*
   a token is bought, not reconciled afterwards (Doc 06 §1).
3. **Routing is by task difficulty.** Sending a one-line CSS tweak to a 200B
   planner is the single biggest avoidable cost in the platform. Model choice
   belongs here, never hard-coded in the harness (Doc 03 §2, Doc 07 §4).

Every call emits an audit record carrying cost, so ``cost_per_successful_deploy``
— the north-star KPI — is computable end to end.
"""

from .client import (
    DEFAULT_MAX_OUTPUT_TOKENS,
    TOOL_CALL_ENVELOPE,
    RouterModelClient,
    extract_tool_call,
    max_output_tokens_from_env,
)
from .errors import (
    RouterError,
    TerminalUpstreamError,
    TransientUpstreamError,
    UpstreamError,
    UpstreamHTTPError,
)
from .openai_upstream import OpenAICompatibleUpstream, UpstreamEndpoint
from .quota import QuotaExceeded, QuotaLedger, TenantQuota
from .router import ModelRouter
from .routing import (
    InMemoryModelSelectionStore,
    ModelCatalog,
    ModelSpec,
    RoutingPolicy,
    SelectionScope,
    default_policy,
    huggingface_router_policy,
    huggingface_unrestricted_policy,
)
from .upstream import Upstream, UpstreamRequest, UpstreamResult

__all__ = [
    "DEFAULT_MAX_OUTPUT_TOKENS",
    "TOOL_CALL_ENVELOPE",
    "InMemoryModelSelectionStore",
    "ModelCatalog",
    "ModelRouter",
    "ModelSpec",
    "OpenAICompatibleUpstream",
    "QuotaExceeded",
    "QuotaLedger",
    "RouterError",
    "RouterModelClient",
    "RoutingPolicy",
    "SelectionScope",
    "TenantQuota",
    "TerminalUpstreamError",
    "TransientUpstreamError",
    "Upstream",
    "UpstreamEndpoint",
    "UpstreamError",
    "UpstreamHTTPError",
    "UpstreamRequest",
    "UpstreamResult",
    "default_policy",
    "extract_tool_call",
    "huggingface_router_policy",
    "huggingface_unrestricted_policy",
    "max_output_tokens_from_env",
]
