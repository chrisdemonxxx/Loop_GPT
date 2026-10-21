"""Tests for the mining-infrastructure denylist.

The denylist is a cheap floor, not a defence. These tests pin two things: that
it catches opportunistic abuse, and — just as importantly — that it does not
deny legitimate build traffic, because a denylist that breaks builds gets turned
off.
"""

from __future__ import annotations

import pytest
from loopit_egress import (
    DEFAULT_REGISTRY_DOMAINS,
    Category,
    EgressPolicy,
    PolicyError,
    Verdict,
    mining_denial,
)


@pytest.mark.parametrize(
    "host",
    [
        "nicehash.com",
        "eu.nanopool.org",
        "pool.supportxmr.com",
        "gulf.moneroocean.stream",
        "xmr.2miners.com",
        "rx.unmineable.com",
    ],
)
def test_known_pools_are_denied(host: str) -> None:
    assert mining_denial(host) is not None


@pytest.mark.parametrize(
    "host",
    [
        "stratum.example.net",
        "my-miningpool.dev",
        "private-xmrpool.io",
        "cryptonight-node.internal",
    ],
)
def test_mining_keywords_catch_unlisted_infrastructure(host: str) -> None:
    assert mining_denial(host) is not None


@pytest.mark.parametrize("port", [3333, 4444, 5555, 7777, 14444, 45700])
def test_stratum_ports_are_denied_regardless_of_hostname(port: int) -> None:
    """A private pool has no recognisable name; the port still gives it away."""
    assert mining_denial("totally-normal.example.com", port) == f"stratum_port:{port}"


@pytest.mark.parametrize("port", [80, 443, 5432, 8080, 3000])
def test_ordinary_ports_are_not_denied(port: int) -> None:
    assert mining_denial("registry.npmjs.org", port) is None


@pytest.mark.parametrize(
    "host",
    [
        "pool.ntp.org",
        "coinbase.com",
        "api.coingecko.com",
        "bitcoin.org",
        "registry.npmjs.org",
        "pypi.org",
        "poolside.fm",
    ],
)
def test_legitimate_hosts_are_not_false_positives(host: str) -> None:
    """A denylist that breaks real builds gets disabled, which is strictly worse."""
    assert mining_denial(host) is None


def test_every_default_registry_domain_survives_the_denylist() -> None:
    for domain in DEFAULT_REGISTRY_DOMAINS:
        assert mining_denial(domain) is None, domain


def test_case_and_trailing_dots_do_not_evade() -> None:
    assert mining_denial("POOL.SupportXMR.CoM.") is not None


def test_subdomain_matching_is_suffix_anchored() -> None:
    """`nicehash.com.evil.test` is not NiceHash and must not be flagged as it."""
    assert mining_denial("nicehash.com.evil.test") is None


def test_a_project_cannot_allowlist_a_mining_pool() -> None:
    """No build step legitimately dials a pool, so this is refused at load time."""
    with pytest.raises(PolicyError, match="mining"):
        EgressPolicy(extra_allow=frozenset({"pool.supportxmr.com"}))


def test_the_policy_denies_pools_even_with_app_apis_open() -> None:
    policy = EgressPolicy(categories=(Category("app_apis", enabled=True),))

    decision = policy.evaluate("eu.nanopool.org")

    assert decision.verdict is Verdict.DENY
    assert decision.reason.startswith("mining_pool:")


def test_the_policy_denies_stratum_ports_on_allowlisted_domains() -> None:
    """An allowlisted registry name must not become a tunnel to a pool."""
    policy = EgressPolicy(categories=(Category("package_registries", enabled=True),))

    decision = policy.evaluate("registry.npmjs.org", port=3333)

    assert decision.verdict is Verdict.DENY
    assert decision.reason == "stratum_port:3333"


def test_metadata_denial_still_takes_precedence() -> None:
    policy = EgressPolicy()

    assert policy.evaluate("metadata.google.internal").reason == "metadata_endpoint"
