"""Red-team suite for egress and metadata controls (invariants I3, I4).

These are release blockers, not unit tests. Doc 02 §5 requires that a red-team
check confirm the metadata endpoint fails closed from inside a sandbox, and Doc
09's Phase 4 exit gate makes a passing red-team run a hard prerequisite for
launch. The ``fast`` subset runs on every pull request.
"""

from __future__ import annotations

import pytest
from egress_rebinding_helpers import assert_dns_rebinding_attempt_is_refused
from loopit_egress import Category, EgressPolicy, PolicyError, Verdict

pytestmark = pytest.mark.fast


def default_policy() -> EgressPolicy:
    """The policy a normal build lease gets."""
    return EgressPolicy(
        categories=(
            Category("package_registries", enabled=True),
            Category("model_router", enabled=True),
            Category("app_apis", enabled=True),
            Category("deploy_targets", enabled=False, window="deploy_step_only"),
        ),
        extra_allow=frozenset({"api.stripe.com"}),
        router_host="router.loop-it.internal",
    )


# --- I4: metadata endpoint must fail closed ----------------------------------


@pytest.mark.parametrize(
    "host",
    [
        "169.254.169.254",  # AWS / GCP / Azure / DO / OpenStack
        "169.254.170.2",  # ECS task metadata
        "169.254.0.1",
        "metadata.google.internal",
        "metadata.goog",
        "metadata",
        "instance-data",
        "instance-data.ec2.internal",
        "fd00:ec2::254",
        "fe80::1",
    ],
)
def test_metadata_endpoints_are_always_denied(host: str) -> None:
    decision = default_policy().evaluate(host)
    assert decision.verdict is Verdict.DENY, f"{host} must be denied"
    assert decision.audit_event_type() == "egress.denied"


def test_metadata_host_cannot_be_allowlisted() -> None:
    with pytest.raises(PolicyError, match="metadata host"):
        EgressPolicy(extra_allow=frozenset({"metadata.google.internal"}))


@pytest.mark.asyncio
async def test_dns_rebinding_to_metadata_is_denied(monkeypatch: pytest.MonkeyPatch) -> None:
    """The proxy must not re-resolve an allowed hostname before connecting."""
    await assert_dns_rebinding_attempt_is_refused(
        monkeypatch,
        host="api.stripe.com",
        request=(b"GET http://api.stripe.com/v1/charges HTTP/1.1\r\nHost: api.stripe.com\r\n\r\n"),
    )


@pytest.mark.parametrize(
    "host",
    ["127.0.0.1", "10.0.0.5", "172.16.4.9", "192.168.1.1", "100.64.0.1", "::1"],
)
def test_internal_and_loopback_ranges_are_denied(host: str) -> None:
    assert default_policy().evaluate(host).verdict is Verdict.DENY


# --- I3: default-deny ---------------------------------------------------------


@pytest.mark.parametrize(
    "host",
    [
        "evil.example.com",
        "pastebin.com",
        "discord.com",
        "raw.githubusercontent.com",
    ],
)
def test_unlisted_destinations_are_denied_by_default(host: str) -> None:
    decision = default_policy().evaluate(host)
    assert decision.verdict is Verdict.DENY
    assert decision.reason == "default_deny"


def test_mining_pools_are_denied_by_name_not_merely_by_omission() -> None:
    """Default-deny already stops these; the named reason is what makes the
    audit stream usable for abuse triage."""
    decision = default_policy().evaluate("pool.minexmr.com")

    assert decision.verdict is Verdict.DENY
    assert decision.reason == "mining_pool:minexmr.com"


def test_an_empty_policy_denies_everything() -> None:
    policy = EgressPolicy()
    for host in ("registry.npmjs.org", "pypi.org", "github.com"):
        assert policy.evaluate(host).verdict is Verdict.DENY


def test_default_action_is_structurally_deny() -> None:
    """There is no allow-all posture; this is not configurable."""
    assert EgressPolicy().default_action == "deny"
    assert EgressPolicy().log_all_requests is True


# --- Allowlist behaves as intended -------------------------------------------


@pytest.mark.parametrize(
    "host",
    ["registry.npmjs.org", "pypi.org", "files.pythonhosted.org", "proxy.golang.org"],
)
def test_package_registries_are_allowed(host: str) -> None:
    decision = default_policy().evaluate(host)
    assert decision.verdict is Verdict.ALLOW
    assert decision.category == "package_registries"


def test_subdomains_of_allowlisted_domains_are_allowed() -> None:
    assert default_policy().evaluate("cdn.registry.npmjs.org").verdict is Verdict.ALLOW


def test_lookalike_domains_are_not_allowed() -> None:
    """Suffix matching must not let 'evil-pypi.org' through on 'pypi.org'."""
    for host in ("evil-pypi.org", "pypi.org.attacker.com", "notregistry.npmjs.org.evil"):
        assert default_policy().evaluate(host).verdict is Verdict.DENY


# --- I5: the router is the only sandbox->model path ---------------------------


def test_the_router_host_is_reachable() -> None:
    decision = default_policy().evaluate("router.loop-it.internal")
    assert decision.verdict is Verdict.ALLOW
    assert decision.category == "model_router"


@pytest.mark.parametrize(
    "host", ["api.openai.com", "api.anthropic.com", "api-inference.huggingface.co"]
)
def test_third_party_model_apis_are_denied(host: str) -> None:
    """A sandbox never calls a model directly; it goes through the router (I5)."""
    assert default_policy().evaluate(host).verdict is Verdict.DENY


# --- Deploy targets are closed during builds ----------------------------------


def test_deploy_targets_are_closed_during_a_build() -> None:
    policy = EgressPolicy(
        categories=(Category("deploy_targets", enabled=True, window="deploy_step_only"),)
    )
    assert policy.evaluate("github.com", step="build").verdict is Verdict.DENY
    assert policy.evaluate("github.com", step=None).verdict is Verdict.DENY


def test_deploy_targets_open_only_during_the_deploy_step() -> None:
    policy = EgressPolicy(
        categories=(Category("deploy_targets", enabled=True, window="deploy_step_only"),)
    )
    assert policy.evaluate("github.com", step="deploy").verdict is Verdict.ALLOW


def test_deploy_targets_cannot_be_always_open() -> None:
    with pytest.raises(PolicyError, match="deploy_step_only"):
        Category("deploy_targets", enabled=True, window="always")


# --- Per-project opt-in -------------------------------------------------------


def test_reviewed_project_api_is_allowed() -> None:
    decision = default_policy().evaluate("api.stripe.com")
    assert decision.verdict is Verdict.ALLOW
    assert decision.category == "app_apis"


def test_ip_literals_cannot_be_allowlisted() -> None:
    """Allowlist by domain so every request resolves and logs through the proxy."""
    with pytest.raises(PolicyError, match="IP literal"):
        EgressPolicy(extra_allow=frozenset({"203.0.113.10"}))


# --- Evasion attempts ---------------------------------------------------------


@pytest.mark.parametrize(
    "host",
    [
        "169.254.169.254.",  # trailing dot
        "METADATA.GOOGLE.INTERNAL",  # case
        "  169.254.169.254  ",  # whitespace
    ],
)
def test_normalisation_evasions_are_denied(host: str) -> None:
    assert default_policy().evaluate(host).verdict is Verdict.DENY


def test_empty_host_is_denied() -> None:
    assert default_policy().evaluate("").verdict is Verdict.DENY
