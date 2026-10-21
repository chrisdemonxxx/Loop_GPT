"""Default-deny egress category policy."""

from __future__ import annotations

import ipaddress
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Literal

from .rules import DEFAULT_RULE_SET, RuleSet

Window = Literal["always", "deploy_step_only", "named_step_only"]
CategoryName = Literal["package_registries", "model_router", "app_apis", "deploy_targets"]

ALWAYS_DENIED_NETWORKS: tuple[ipaddress.IPv4Network | ipaddress.IPv6Network, ...] = (
    ipaddress.ip_network("169.254.0.0/16"),
    ipaddress.ip_network("fd00:ec2::/32"),
    ipaddress.ip_network("fe80::/10"),
    ipaddress.ip_network("127.0.0.0/8"),
    ipaddress.ip_network("::1/128"),
    ipaddress.ip_network("10.0.0.0/8"),
    ipaddress.ip_network("172.16.0.0/12"),
    ipaddress.ip_network("192.168.0.0/16"),
    ipaddress.ip_network("100.64.0.0/10"),
)

ALWAYS_DENIED_HOSTS: frozenset[str] = frozenset(
    {
        "metadata.google.internal",
        "metadata.goog",
        "metadata",
        "instance-data",
        "instance-data.ec2.internal",
    }
)

MINING_POOL_DOMAINS: frozenset[str] = frozenset(
    {
        "nicehash.com",
        "nanopool.org",
        "ethermine.org",
        "f2pool.com",
        "antpool.com",
        "poolin.com",
        "viabtc.com",
        "slushpool.com",
        "braiins.com",
        "minexmr.com",
        "supportxmr.com",
        "moneroocean.stream",
        "hashvault.pro",
        "unmineable.com",
        "2miners.com",
        "herominers.com",
        "flexpool.io",
        "k1pool.com",
        "zergpool.com",
        "prohashing.com",
        "miningpoolhub.com",
        "dxpool.com",
        "emcd.io",
        "woolypooly.com",
        "c3pool.com",
        "xmrpool.eu",
        "crazypool.org",
    }
)
MINING_HOST_KEYWORDS: tuple[str, ...] = (
    "stratum",
    "miningpool",
    "mining-pool",
    "xmrpool",
    "moneropool",
    "ethpool",
    "cryptonight",
    "randomx",
)
STRATUM_PORTS: frozenset[int] = frozenset({3333, 3334, 4444, 5555, 5556, 7777, 8888, 14444, 45700})


class EgressVerdict(StrEnum):
    ALLOW = "allow"
    DENY = "deny"


@dataclass(frozen=True, slots=True)
class EgressDecision:
    verdict: EgressVerdict
    reason: str
    category: CategoryName | None = None

    @property
    def allowed(self) -> bool:
        return self.verdict is EgressVerdict.ALLOW


@dataclass(frozen=True, slots=True)
class Category:
    name: CategoryName
    enabled: bool
    window: Window = "always"

    def __post_init__(self) -> None:
        if self.name == "deploy_targets" and self.window != "deploy_step_only":
            raise ValueError("deploy_targets must use window='deploy_step_only'")


@dataclass(slots=True)
class EgressPolicy:
    """Sandbox egress policy with service-compatible semantics."""

    categories: tuple[Category, ...] = ()
    extra_allow: frozenset[str] = field(default_factory=frozenset)
    router_host: str | None = None
    default_action: Literal["deny"] = "deny"
    log_all_requests: Literal[True] = True
    rule_set: RuleSet = DEFAULT_RULE_SET

    def __post_init__(self) -> None:
        seen: set[str] = set()
        for category in self.categories:
            if category.name in seen:
                raise ValueError(f"duplicate egress category {category.name!r}")
            seen.add(category.name)
        for domain in self.extra_allow:
            normalised = domain.lower().strip().rstrip(".")
            if normalised in ALWAYS_DENIED_HOSTS or _is_ip_literal(normalised):
                raise ValueError(f"{domain!r} can never be allowlisted")
            mining = mining_denial(normalised)
            if mining is not None:
                raise ValueError(f"{domain!r} is denied abuse infrastructure: {mining}")

    def evaluate(
        self,
        host: str,
        *,
        step: str | None = None,
        resolved_ips: tuple[str, ...] = (),
        port: int | None = None,
    ) -> EgressDecision:
        normalised = host.strip().rstrip(".").lower()
        if not normalised:
            return EgressDecision(EgressVerdict.DENY, "empty host")

        if normalised in ALWAYS_DENIED_HOSTS:
            return EgressDecision(EgressVerdict.DENY, "metadata_endpoint")

        mining = mining_denial(normalised, port)
        if mining is not None:
            return EgressDecision(EgressVerdict.DENY, mining)

        for candidate in (normalised, *resolved_ips):
            denied = _denied_network_for(candidate)
            if denied is not None:
                reason = (
                    "metadata_endpoint"
                    if denied.version == 4 and str(denied).startswith("169.254")
                    else "denied_network"
                )
                return EgressDecision(EgressVerdict.DENY, f"{reason}:{denied}")

        if self.router_host and normalised == self.router_host.lower():
            if self._category_open("model_router", step):
                return EgressDecision(EgressVerdict.ALLOW, "model_router", "model_router")
            return EgressDecision(
                EgressVerdict.DENY, "model_router category disabled", "model_router"
            )

        category_domains = {
            category.name: category.domains for category in self.rule_set.domain_categories
        }
        for category in self.categories:
            domains = frozenset(category_domains.get(category.name, ()))
            if not _host_matches_any(normalised, domains):
                continue
            if not self._category_open(category.name, step):
                return EgressDecision(
                    EgressVerdict.DENY,
                    f"category {category.name} closed for step {step!r}",
                    category.name,
                )
            return EgressDecision(EgressVerdict.ALLOW, f"category:{category.name}", category.name)

        if _host_matches_any(normalised, self.extra_allow):
            if self._category_open("app_apis", step):
                return EgressDecision(EgressVerdict.ALLOW, "extra_allow", "app_apis")
            return EgressDecision(EgressVerdict.DENY, "app_apis category disabled", "app_apis")

        return EgressDecision(EgressVerdict.DENY, "default_deny")

    def _category_open(self, name: CategoryName, step: str | None) -> bool:
        for category in self.categories:
            if category.name != name:
                continue
            if not category.enabled:
                return False
            if category.window == "deploy_step_only":
                return step == "deploy"
            if category.window == "named_step_only":
                return step is not None
            return True
        return False


def _is_ip_literal(value: str) -> bool:
    try:
        ipaddress.ip_address(value)
    except ValueError:
        return False
    return True


def _denied_network_for(value: str) -> ipaddress.IPv4Network | ipaddress.IPv6Network | None:
    try:
        address = ipaddress.ip_address(value)
    except ValueError:
        return None
    for network in ALWAYS_DENIED_NETWORKS:
        if address.version == network.version and address in network:
            return network
    return None


def _host_matches_any(host: str, domains: frozenset[str]) -> bool:
    for domain in domains:
        candidate = domain.lower()
        if candidate.startswith("*."):
            suffix = candidate[1:]
            if host.endswith(suffix) and host != suffix.lstrip("."):
                return True
        elif host == candidate or host.endswith(f".{candidate}"):
            return True
    return False


def mining_denial(host: str, port: int | None = None) -> str | None:
    """Return a stable denial reason for known mining infrastructure."""
    normalised = host.strip().rstrip(".").lower()
    for domain in MINING_POOL_DOMAINS:
        if normalised == domain or normalised.endswith(f".{domain}"):
            return f"mining_pool:{domain}"
    for keyword in MINING_HOST_KEYWORDS:
        if keyword in normalised:
            return f"mining_keyword:{keyword}"
    if port is not None and port in STRATUM_PORTS:
        return f"stratum_port:{port}"
    return None
