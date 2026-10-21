"""The agent harness.

The model is the engine; this is the car. This package owns the control-plane
half of the agent loop: budgets, audit emission, tool-call validation, and the
think → act → observe cycle.

It never executes agent-generated code. Execution is delegated to a leased
sandbox in the data plane over a signed, least-privilege channel (invariant I1,
Doc 04 §0). Anything in this package that looks like it runs a command is
issuing an *instruction* to a sandbox, not running it locally.
"""

from .audit import AuditEvent, AuditSink, InMemoryAuditSink, redact
from .budget import Budget, BudgetExceeded, BudgetLedger
from .context import (
    CHARS_PER_TOKEN,
    ContextWindow,
    ModelBackedCondenser,
    StablePrefix,
    default_condenser,
    estimate_messages,
    estimate_tokens,
)
from .gates import (
    ApprovalBindings,
    approval_binding_hash,
    canonical_gate_json,
    gate_id_for,
    normalise_gate_value,
)
from .loop import AgentLoop, LoopOutcome, LoopResult
from .model import Message, ModelClient, ModelResponse
from .observation import Observation, untrusted
from .reflection import (
    DEFAULT_REPEAT_LIMIT,
    FailureTracker,
    VerificationVerdict,
    failure_signature,
)
from .retrieval import (
    Hit,
    Index,
    ReadResult,
    Retrieval,
    Span,
    render_hits,
    render_reads,
    retrieve,
    select_spans,
)
from .tools import ToolCall, ToolExecutor, ToolRejected, ToolResult, validate_tool_call

__all__ = [
    "CHARS_PER_TOKEN",
    "DEFAULT_REPEAT_LIMIT",
    "AgentLoop",
    "ApprovalBindings",
    "AuditEvent",
    "AuditSink",
    "Budget",
    "BudgetExceeded",
    "BudgetLedger",
    "ContextWindow",
    "FailureTracker",
    "Hit",
    "InMemoryAuditSink",
    "Index",
    "LoopOutcome",
    "LoopResult",
    "Message",
    "ModelBackedCondenser",
    "ModelClient",
    "ModelResponse",
    "Observation",
    "ReadResult",
    "Retrieval",
    "Span",
    "StablePrefix",
    "ToolCall",
    "ToolExecutor",
    "ToolRejected",
    "ToolResult",
    "VerificationVerdict",
    "approval_binding_hash",
    "canonical_gate_json",
    "default_condenser",
    "estimate_messages",
    "estimate_tokens",
    "failure_signature",
    "gate_id_for",
    "normalise_gate_value",
    "redact",
    "render_hits",
    "render_reads",
    "retrieve",
    "select_spans",
    "untrusted",
    "validate_tool_call",
]
