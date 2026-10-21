"""Tests for the model router.

Covers invariant I5 (no credential ever reaches a sandbox), pre-spend quota
enforcement, difficulty routing with same-class fallback, and cost attribution.
"""

from __future__ import annotations

from typing import Any

import pytest
from loopit_agent_core.audit import InMemoryAuditSink
from loopit_router import (
    InMemoryModelSelectionStore,
    ModelRouter,
    ModelSpec,
    QuotaExceeded,
    QuotaLedger,
    RoutingPolicy,
    SelectionScope,
    TenantQuota,
    Upstream,
    UpstreamError,
    UpstreamResult,
    default_policy,
)
from loopit_router.quota import QuotaError
from loopit_router.routing import RoutingError
from loopit_router.upstream import StaticSecretResolver, UpstreamRequest

TENANT = "tenant_a"
SECRET = "sk-live-do-not-leak-this-value"


class RecordingUpstream:
    """Captures every request so tests can assert on what crossed the boundary."""

    def __init__(self, result: UpstreamResult | None = None) -> None:
        self.requests: list[UpstreamRequest] = []
        self._result = result or UpstreamResult(
            content='{"ok": true}', input_tokens=1000, output_tokens=500
        )

    def complete(self, request: UpstreamRequest) -> UpstreamResult:
        self.requests.append(request)
        return self._result


class FailingUpstream:
    def __init__(self, fail_models: set[str]) -> None:
        self.fail_models = fail_models
        self.requests: list[UpstreamRequest] = []

    def complete(self, request: UpstreamRequest) -> UpstreamResult:
        self.requests.append(request)
        if request.model in self.fail_models:
            raise ConnectionError(f"{request.model} unreachable")
        return UpstreamResult(content="ok", input_tokens=100, output_tokens=50, model=request.model)


@pytest.fixture
def secrets() -> StaticSecretResolver:
    return StaticSecretResolver(
        {
            "secrets://models/small": SECRET,
            "secrets://models/coder": SECRET,
            "secrets://models/planner": SECRET,
        }
    )


@pytest.fixture
def ledger() -> QuotaLedger:
    return QuotaLedger({TENANT: TenantQuota(tenant_id=TENANT, credit_limit=100.0)})


@pytest.fixture
def audit() -> InMemoryAuditSink:
    return InMemoryAuditSink()


def build_router(
    upstream: Upstream,
    ledger: QuotaLedger,
    secrets: StaticSecretResolver,
    audit: InMemoryAuditSink,
    policy: RoutingPolicy | None = None,
) -> ModelRouter:
    return ModelRouter(
        policy=policy or default_policy(),
        upstream=upstream,
        ledger=ledger,
        secrets=secrets,
        audit=audit,
    )


# --- Routing ------------------------------------------------------------------


def test_each_difficulty_routes_to_its_own_model(
    ledger: QuotaLedger, secrets: StaticSecretResolver, audit: InMemoryAuditSink
) -> None:
    upstream = RecordingUpstream()
    router = build_router(upstream, ledger, secrets, audit)

    for difficulty in ("trivial", "implementation", "planning"):
        router.complete(
            tenant_id=TENANT, difficulty=difficulty, messages=[{"role": "user", "content": "hi"}]
        )

    assert [request.model for request in upstream.requests] == [
        "loopit/small",
        "loopit/coder",
        "loopit/planner",
    ]


def test_a_failed_model_falls_back_within_the_same_class(
    ledger: QuotaLedger, secrets: StaticSecretResolver, audit: InMemoryAuditSink
) -> None:
    upstream = FailingUpstream(fail_models={"loopit/coder"})
    router = build_router(upstream, ledger, secrets, audit)

    result = router.complete(
        tenant_id=TENANT, difficulty="implementation", messages=[{"role": "user", "content": "x"}]
    )

    assert result.model == "loopit/planner"
    assert [request.model for request in upstream.requests] == ["loopit/coder", "loopit/planner"]


def test_exhausting_every_candidate_raises_rather_than_silently_degrading(
    ledger: QuotaLedger, secrets: StaticSecretResolver, audit: InMemoryAuditSink
) -> None:
    upstream = FailingUpstream(fail_models={"loopit/planner"})
    router = build_router(upstream, ledger, secrets, audit)

    with pytest.raises(UpstreamError) as caught:
        router.complete(
            tenant_id=TENANT, difficulty="planning", messages=[{"role": "user", "content": "x"}]
        )
    assert len(caught.value.attempts) == 1


def test_a_policy_missing_a_difficulty_is_refused_at_load_time() -> None:
    spec = ModelSpec(
        name="m", backend="vllm", credential_ref="secrets://m", license_id="apache-2.0"
    )
    with pytest.raises(RoutingError, match="planning"):
        RoutingPolicy(routes={"trivial": (spec,), "implementation": (spec,)})


def test_every_served_model_declares_a_license() -> None:
    with pytest.raises(RoutingError, match="license"):
        ModelSpec(name="m", backend="vllm", credential_ref="secrets://m", license_id="")

    licenses = default_policy().licenses()
    assert licenses and all(licenses.values())


def test_catalog_rejects_unknown_or_ineligible_model_selection() -> None:
    catalog = default_policy().catalog

    with pytest.raises(RoutingError, match="unknown model"):
        catalog.policy_from_ids(
            {
                "trivial": ("missing",),
                "implementation": ("loopit/coder",),
                "planning": ("loopit/planner",),
            }
        )

    with pytest.raises(RoutingError, match="not eligible"):
        catalog.policy_from_ids(
            {
                "trivial": ("loopit/small",),
                "implementation": ("loopit/coder",),
                "planning": ("loopit/small",),
            }
        )


def test_project_selection_overrides_org_selection_for_difficulty_routing(
    ledger: QuotaLedger, secrets: StaticSecretResolver, audit: InMemoryAuditSink
) -> None:
    store = InMemoryModelSelectionStore()
    catalog = default_policy().catalog
    store.put(
        SelectionScope(TENANT),
        catalog.policy_from_ids(
            {
                "trivial": ("loopit/small",),
                "implementation": ("loopit/coder",),
                "planning": ("loopit/planner",),
            }
        ),
    )
    store.put(
        SelectionScope(TENANT, "project"),
        catalog.policy_from_ids(
            {
                "trivial": ("loopit/coder",),
                "implementation": ("loopit/planner",),
                "planning": ("loopit/planner",),
            }
        ),
    )
    upstream = RecordingUpstream()
    router = ModelRouter(
        policy=default_policy(),
        upstream=upstream,
        ledger=ledger,
        secrets=secrets,
        audit=audit,
        selection_store=store,
    )

    router.complete(
        tenant_id=TENANT,
        project_id="project",
        difficulty="trivial",
        messages=[{"role": "user", "content": "x"}],
    )

    assert upstream.requests[0].model == "loopit/coder"


# --- Invariant I5: credentials never reach the sandbox ------------------------


def test_the_credential_is_resolved_server_side_and_never_stored_in_the_policy() -> None:
    for specs in default_policy().routes.values():
        for spec in specs:
            assert spec.credential_ref.startswith("secrets://")


def test_a_literal_api_key_in_a_model_spec_is_rejected() -> None:
    with pytest.raises(RoutingError, match="literal API key"):
        ModelSpec(name="m", backend="vllm", credential_ref=SECRET, license_id="apache-2.0")


def test_an_unregistered_model_is_never_served(
    ledger: QuotaLedger, audit: InMemoryAuditSink
) -> None:
    spec = ModelSpec(
        name="unregistered/model",
        backend="vllm",
        credential_ref="secrets://models/unregistered",
        license_id="apache-2.0",
    )
    policy = RoutingPolicy(routes={difficulty: (spec,) for difficulty in default_policy().routes})
    upstream = RecordingUpstream()
    router = ModelRouter(
        policy=policy,
        upstream=upstream,
        ledger=ledger,
        secrets=StaticSecretResolver({"secrets://models/unregistered": SECRET}),
        audit=audit,
    )

    with pytest.raises(UpstreamError):
        router.complete(
            tenant_id=TENANT, difficulty="trivial", messages=[{"role": "user", "content": "x"}]
        )

    assert upstream.requests == []
    assert audit.of_type("model.license_denied")


def test_the_credential_never_appears_in_the_audit_trail(
    ledger: QuotaLedger, secrets: StaticSecretResolver, audit: InMemoryAuditSink
) -> None:
    router = build_router(RecordingUpstream(), ledger, secrets, audit)
    router.complete(
        tenant_id=TENANT, difficulty="trivial", messages=[{"role": "user", "content": "hi"}]
    )

    serialised = str([event.to_dict() for event in audit.events])
    assert SECRET not in serialised


def test_the_result_returned_toward_the_caller_carries_no_credential(
    ledger: QuotaLedger, secrets: StaticSecretResolver, audit: InMemoryAuditSink
) -> None:
    router = build_router(RecordingUpstream(), ledger, secrets, audit)
    result = router.complete(
        tenant_id=TENANT, difficulty="trivial", messages=[{"role": "user", "content": "hi"}]
    )
    assert SECRET not in str(result)


# --- Quota --------------------------------------------------------------------


def test_a_tenant_over_quota_is_refused_before_any_token_is_spent(
    secrets: StaticSecretResolver, audit: InMemoryAuditSink
) -> None:
    ledger = QuotaLedger({TENANT: TenantQuota(tenant_id=TENANT, credit_limit=0.0)})
    upstream = RecordingUpstream()
    router = build_router(upstream, ledger, secrets, audit)

    with pytest.raises(QuotaExceeded):
        router.complete(
            tenant_id=TENANT, difficulty="planning", messages=[{"role": "user", "content": "x"}]
        )

    assert upstream.requests == []
    assert ledger.spent(TENANT) == 0.0


def test_a_quota_refusal_is_audited(
    secrets: StaticSecretResolver, audit: InMemoryAuditSink
) -> None:
    ledger = QuotaLedger({TENANT: TenantQuota(tenant_id=TENANT, credit_limit=0.0)})
    router = build_router(RecordingUpstream(), ledger, secrets, audit)

    with pytest.raises(QuotaExceeded):
        router.complete(
            tenant_id=TENANT, difficulty="planning", messages=[{"role": "user", "content": "x"}]
        )

    denials = audit.of_type("quota.denied")
    assert len(denials) == 1
    assert denials[0].outcome == "denied"


def test_an_unknown_tenant_is_refused_rather_than_defaulted_to_unlimited(
    secrets: StaticSecretResolver, audit: InMemoryAuditSink
) -> None:
    router = build_router(RecordingUpstream(), QuotaLedger(), secrets, audit)
    with pytest.raises(QuotaError, match="no quota configured"):
        router.complete(
            tenant_id="ghost", difficulty="trivial", messages=[{"role": "user", "content": "x"}]
        )


def test_a_reservation_is_released_after_the_call(
    ledger: QuotaLedger, secrets: StaticSecretResolver, audit: InMemoryAuditSink
) -> None:
    router = build_router(RecordingUpstream(), ledger, secrets, audit)
    router.complete(
        tenant_id=TENANT, difficulty="trivial", messages=[{"role": "user", "content": "hi"}]
    )
    # Only the settled cost remains committed; the pessimistic estimate is gone.
    assert ledger.remaining(TENANT) == pytest.approx(100.0 - ledger.spent(TENANT))


def test_spend_accumulates_across_calls(
    ledger: QuotaLedger, secrets: StaticSecretResolver, audit: InMemoryAuditSink
) -> None:
    router = build_router(RecordingUpstream(), ledger, secrets, audit)
    for _ in range(3):
        router.complete(
            tenant_id=TENANT, difficulty="trivial", messages=[{"role": "user", "content": "hi"}]
        )
    assert ledger.spent(TENANT) > 0
    assert ledger.remaining(TENANT) < 100.0


def test_a_negative_credit_limit_is_rejected() -> None:
    with pytest.raises(QuotaError, match="negative"):
        TenantQuota(tenant_id=TENANT, credit_limit=-1.0)


def test_concurrency_must_be_at_least_one() -> None:
    with pytest.raises(QuotaError, match="at least 1"):
        TenantQuota(tenant_id=TENANT, credit_limit=1.0, concurrent_runs=0)


# --- Cost attribution ---------------------------------------------------------


def test_every_successful_call_emits_cost_for_the_north_star_kpi(
    ledger: QuotaLedger, secrets: StaticSecretResolver, audit: InMemoryAuditSink
) -> None:
    router = build_router(RecordingUpstream(), ledger, secrets, audit)
    router.complete(
        tenant_id=TENANT, difficulty="implementation", messages=[{"role": "user", "content": "x"}]
    )

    events = audit.of_type("model.called")
    assert len(events) == 1
    cost = events[0].cost
    assert cost is not None
    assert cost["credits"] > 0
    assert cost["input_tokens"] == 1000
    assert cost["output_tokens"] == 500
    assert events[0].tenant_id == TENANT


def test_cached_prompt_tokens_are_not_charged() -> None:
    spec = ModelSpec(
        name="m",
        backend="vllm",
        credential_ref="secrets://m",
        license_id="apache-2.0",
        credits_per_1k_input=1.0,
        credits_per_1k_output=0.0,
    )
    assert spec.credits_for(1000, 0) == pytest.approx(1.0)
    assert spec.credits_for(1000, 0, cached=750) == pytest.approx(0.25)


def test_a_failed_call_is_also_audited(
    ledger: QuotaLedger, secrets: StaticSecretResolver, audit: InMemoryAuditSink
) -> None:
    router = build_router(FailingUpstream({"loopit/coder"}), ledger, secrets, audit)
    router.complete(
        tenant_id=TENANT, difficulty="implementation", messages=[{"role": "user", "content": "x"}]
    )

    outcomes = [event.outcome for event in audit.of_type("model.called")]
    assert outcomes == ["failure", "success"]


def test_fallback_depth_is_recorded_so_degradation_is_visible(
    ledger: QuotaLedger, secrets: StaticSecretResolver, audit: InMemoryAuditSink
) -> None:
    router = build_router(FailingUpstream({"loopit/coder"}), ledger, secrets, audit)
    router.complete(
        tenant_id=TENANT, difficulty="implementation", messages=[{"role": "user", "content": "x"}]
    )
    success = next(e for e in audit.of_type("model.called") if e.outcome == "success")
    assert success.detail["fallback_depth"] == 1


# --- Structured output --------------------------------------------------------


def test_a_response_schema_is_passed_through_to_the_serving_layer(
    ledger: QuotaLedger, secrets: StaticSecretResolver, audit: InMemoryAuditSink
) -> None:
    upstream = RecordingUpstream()
    router = build_router(upstream, ledger, secrets, audit)
    schema = {"type": "object", "properties": {"tool": {"type": "string"}}}

    router.complete(
        tenant_id=TENANT,
        difficulty="implementation",
        messages=[{"role": "user", "content": "x"}],
        response_schema=schema,
    )

    assert upstream.requests[0].response_schema == schema
    assert upstream.requests[0].uses_structured_output


def test_structured_output_use_is_recorded(
    ledger: QuotaLedger, secrets: StaticSecretResolver, audit: InMemoryAuditSink
) -> None:
    router = build_router(RecordingUpstream(), ledger, secrets, audit)
    router.complete(
        tenant_id=TENANT,
        difficulty="trivial",
        messages=[{"role": "user", "content": "x"}],
        response_schema={"type": "object"},
    )
    assert audit.of_type("model.called")[0].detail["structured_output"] is True


class StreamingRecordingUpstream(RecordingUpstream):
    """A fake that advertises the streaming capability."""

    def complete_stream(self, request: UpstreamRequest, on_token: Any) -> UpstreamResult:
        self.requests.append(request)
        on_token("Hel")
        on_token("lo")
        return self._result


def test_on_token_streams_through_a_streaming_upstream(
    ledger: QuotaLedger, secrets: StaticSecretResolver, audit: InMemoryAuditSink
) -> None:
    router = build_router(StreamingRecordingUpstream(), ledger, secrets, audit)
    tokens: list[str] = []

    router.complete(
        tenant_id=TENANT,
        difficulty="trivial",
        messages=[{"role": "user", "content": "x"}],
        on_token=tokens.append,
    )

    assert tokens == ["Hel", "lo"]


def test_on_token_degrades_to_one_chunk_on_a_plain_upstream(
    ledger: QuotaLedger, secrets: StaticSecretResolver, audit: InMemoryAuditSink
) -> None:
    router = build_router(RecordingUpstream(), ledger, secrets, audit)
    tokens: list[str] = []

    router.complete(
        tenant_id=TENANT,
        difficulty="trivial",
        messages=[{"role": "user", "content": "x"}],
        on_token=tokens.append,
    )

    assert tokens == ['{"ok": true}']
