from __future__ import annotations

import pytest
from loopit_policy import (
    FailureClass,
    PlanLimits,
    QuotaRequest,
    UsageSnapshot,
    classify_failure,
    evaluate_quota,
    is_retryable,
)


def _limits() -> PlanLimits:
    return PlanLimits(
        max_tokens_per_minute=100,
        max_credits_per_day=10.0,
        max_sandbox_leases=2,
        max_egress_bytes_per_day=1_000,
    )


def test_quota_allows_request_within_remaining_budget() -> None:
    decision = evaluate_quota(QuotaRequest(tokens=10, credits=1), UsageSnapshot(), _limits())

    assert decision.allowed
    assert decision.reason == "within quota"


@pytest.mark.parametrize(
    ("quota_request", "reason"),
    [
        (QuotaRequest(tokens=101), "tokens_per_minute quota exceeded"),
        (QuotaRequest(credits=10.1), "credits_per_day quota exceeded"),
        (QuotaRequest(sandbox_leases=3), "sandbox_leases quota exceeded"),
        (QuotaRequest(egress_bytes=1_001), "egress_bytes_per_day quota exceeded"),
        (QuotaRequest(always_on_apps=1), "always_on_apps quota exceeded"),
        (QuotaRequest(custom_domains=1), "custom_domains quota exceeded"),
        (QuotaRequest(hosting_egress_bytes=1), "hosting_egress_bytes_per_day quota exceeded"),
        (QuotaRequest(tokens=-1), "invalid negative tokens_per_minute request"),
    ],
)
def test_quota_denies_before_spend(quota_request: QuotaRequest, reason: str) -> None:
    decision = evaluate_quota(quota_request, UsageSnapshot(), _limits())

    assert not decision.allowed
    assert decision.reason == reason


def test_quota_allows_hosting_and_domain_requests_under_plan_limits() -> None:
    limits = PlanLimits(
        max_tokens_per_minute=100,
        max_credits_per_day=10.0,
        max_sandbox_leases=2,
        max_egress_bytes_per_day=1_000,
        max_always_on_apps=2,
        max_custom_domains=3,
        max_hosting_egress_bytes_per_day=10_000,
    )
    usage = UsageSnapshot(
        active_always_on_apps=1,
        attached_custom_domains=2,
        hosting_egress_bytes_today=9_000,
    )
    request = QuotaRequest(always_on_apps=1, custom_domains=1, hosting_egress_bytes=1_000)

    decision = evaluate_quota(request, usage, limits)

    assert decision.allowed
    assert decision.remaining["always_on_apps"] == 1
    assert decision.remaining["custom_domains"] == 1
    assert decision.remaining["hosting_egress_bytes_per_day"] == 1_000


@pytest.mark.parametrize(
    ("error", "failure_class", "retryable"),
    [
        ("timeout talking to sandbox", FailureClass.TRANSIENT, True),
        ("test failed: AssertionError", FailureClass.VERIFICATION, True),
        ("credits exhausted", FailureClass.BUDGET, False),
        ("merge conflict in package.json", FailureClass.MERGE_CONFLICT, True),
        ("approval denied by human", FailureClass.GATE_REJECTED, False),
        ("syntax does not compute", FailureClass.HARD_ERROR, False),
    ],
)
def test_failure_taxonomy(error: str, failure_class: FailureClass, retryable: bool) -> None:
    classified = classify_failure(error)

    assert classified is failure_class
    assert is_retryable(classified) is retryable
