"""Policy engine for Loop-it infrastructure-abuse controls.

This package intentionally covers infrastructure policy only. Model-content
policy remains a separate enforcement path (PLAN invariant I11).
"""

from .actions import (
    ActionKind,
    ActionVerdict,
    Destructiveness,
    GateRequirement,
    ProposedAction,
    Reversibility,
    classify_action,
)
from .analyzer import Finding, FindingSeverity, analyze_proposed_actions
from .egress import Category, EgressDecision, EgressPolicy, EgressVerdict
from .failures import FailureClass, classify_failure, is_retryable
from .quota import PlanLimits, QuotaDecision, QuotaRequest, UsageSnapshot, evaluate_quota
from .rules import (
    BUILDER_RULE_SET,
    DEFAULT_RULE_SET,
    STRICT_RULE_SET,
    RuleSet,
    rule_set_as_dict,
    rule_set_for_preset,
)

__all__ = [
    "BUILDER_RULE_SET",
    "DEFAULT_RULE_SET",
    "STRICT_RULE_SET",
    "ActionKind",
    "ActionVerdict",
    "Category",
    "Destructiveness",
    "EgressDecision",
    "EgressPolicy",
    "EgressVerdict",
    "FailureClass",
    "Finding",
    "FindingSeverity",
    "GateRequirement",
    "PlanLimits",
    "ProposedAction",
    "QuotaDecision",
    "QuotaRequest",
    "Reversibility",
    "RuleSet",
    "UsageSnapshot",
    "analyze_proposed_actions",
    "classify_action",
    "classify_failure",
    "evaluate_quota",
    "is_retryable",
    "rule_set_as_dict",
    "rule_set_for_preset",
]
