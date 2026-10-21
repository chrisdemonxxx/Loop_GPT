from __future__ import annotations

import pytest
from loopit_policy import Category, EgressPolicy, EgressVerdict


def test_package_registry_category_allows_known_registry() -> None:
    policy = EgressPolicy(categories=(Category("package_registries", True),))

    decision = policy.evaluate("registry.npmjs.org")

    assert decision.verdict is EgressVerdict.ALLOW
    assert decision.category == "package_registries"


def test_default_deny_for_unknown_domain() -> None:
    policy = EgressPolicy(categories=(Category("package_registries", True),))

    assert policy.evaluate("example.com").reason == "default_deny"


@pytest.mark.parametrize(
    "host",
    [
        "169.254.169.254",
        "169.254.1.1",
        "metadata.google.internal",
        "127.0.0.1",
        "10.0.0.5",
        "fd00:ec2::254",
    ],
)
def test_metadata_and_link_local_are_never_allowed(host: str) -> None:
    policy = EgressPolicy(
        categories=(
            Category("package_registries", True),
            Category("model_router", True),
            Category("app_apis", True),
        ),
        extra_allow=frozenset({"metadata.google.internal.example.com"}),
        router_host="router.loop-it.local",
    )

    decision = policy.evaluate(host)

    assert decision.verdict is EgressVerdict.DENY
    assert "metadata_endpoint" in decision.reason or "denied_network" in decision.reason


def test_resolved_ip_blocks_dns_rebinding_to_metadata() -> None:
    policy = EgressPolicy(
        categories=(Category("app_apis", True),),
        extra_allow=frozenset({"api.example.com"}),
    )

    assert policy.evaluate("api.example.com", resolved_ips=("169.254.169.254",)).allowed is False


def test_deploy_targets_only_open_during_deploy_step() -> None:
    policy = EgressPolicy(categories=(Category("deploy_targets", True, "deploy_step_only"),))

    assert not policy.evaluate("api.github.com", step="build").allowed
    assert policy.evaluate("api.github.com", step="deploy").allowed


def test_model_router_requires_category() -> None:
    closed = EgressPolicy(router_host="router.loop-it.local")
    open_policy = EgressPolicy(
        categories=(Category("model_router", True),), router_host="router.loop-it.local"
    )

    assert not closed.evaluate("router.loop-it.local").allowed
    assert open_policy.evaluate("router.loop-it.local").allowed


def test_extra_allow_requires_app_apis_category() -> None:
    policy = EgressPolicy(
        categories=(Category("app_apis", True),), extra_allow=frozenset({"api.stripe.com"})
    )

    assert policy.evaluate("api.stripe.com").category == "app_apis"


def test_metadata_host_cannot_be_configured_as_extra_allow() -> None:
    with pytest.raises(ValueError):
        EgressPolicy(extra_allow=frozenset({"metadata.google.internal"}))


def test_mining_infrastructure_is_never_allowed() -> None:
    policy = EgressPolicy(
        categories=(Category("app_apis", True),), extra_allow=frozenset({"api.example.com"})
    )

    assert policy.evaluate("pool.supportxmr.com").reason == "mining_pool:supportxmr.com"
    assert policy.evaluate("api.example.com", port=3333).reason == "stratum_port:3333"
