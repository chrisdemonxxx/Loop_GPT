"""The egress decision engine.

Every outbound request from a sandbox is resolved here. The engine returns a
:class:`Decision` that the proxy enforces and writes to the audit log — allowed
requests as well as denied ones, because forensics needs both.
"""

from __future__ import annotations

import ipaddress
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Literal

from .denylist import mining_denial
from .registries import CATEGORY_DOMAINS

CategoryName = Literal["package_registries", "model_router", "app_apis", "deploy_targets"]
Window = Literal["always", "deploy_step_only", "named_step_only"]

#: Ranges that are denied unconditionally and cannot be allowlisted (I4).
#:
#: The cloud metadata endpoint is the classic single misconfiguration that turns
#: a sandbox escape into a full account takeover, so it is blocked at the packet
#: level *and* here, and verified fail-closed by the red-team suite.
ALWAYS_DENIED_NETWORKS: tuple[ipaddress.IPv4Network | ipaddress.IPv6Network, ...] = (
    ipaddress.ip_network("169.254.0.0/16"),  # link-local, incl. 169.254.169.254
    ipaddress.ip_network("fd00:ec2::/32"),  # AWS IMDSv6
    ipaddress.ip_network("fe80::/10"),  # IPv6 link-local
    ipaddress.ip_network("127.0.0.0/8"),  # host loopback
    ipaddress.ip_network("::1/128"),
    ipaddress.ip_network("10.0.0.0/8"),  # internal service ranges
    ipaddress.ip_network("172.16.0.0/12"),
    ipaddress.ip_network("192.168.0.0/16"),
    ipaddress.ip_network("100.64.0.0/10"),  # carrier-grade NAT / provider fabric
)

#: Hostnames providers use for metadata, denied regardless of resolution (I4).
ALWAYS_DENIED_HOSTS: frozenset[str] = frozenset(
    {
        "metadata.google.internal",
        "metadata.goog",
        "metadata",
        "instance-data",
        "instance-data.ec2.internal",
    }
)


class PolicyError(ValueError):
    """The policy itself is invalid and must not be loaded."""


class Verdict(StrEnum):
    ALLOW = "allow"
    DENY = "deny"


@dataclass(frozen=True, slots=True)
class Decision:
    """The result of evaluating one outbound request."""

    verdict: Verdict
    reason: str
    category: CategoryName | None = None

    @property
    def allowed(self) -> bool:
        return self.verdict is Verdict.ALLOW

    def audit_event_type(self) -> str:
        return "egress.allowed" if self.allowed else "egress.denied"


@dataclass(frozen=True, slots=True)
class Category:
    """One allowlist category on a lease's policy."""

    name: CategoryName
    enabled: bool
    window: Window = "always"

    def __post_init__(self) -> None:
        if self.name == "deploy_targets" and self.window != "deploy_step_only":
            raise PolicyError(
                "deploy_targets must use window='deploy_step_only'; deploy credentials "
                "and destinations are not open during a general build"
            )


@dataclass(slots=True)
class EgressPolicy:
    """A sandbox lease's egress policy. Default-deny, always.

    Args:
        categories: allowlist categories and whether each is enabled.
        extra_allow: per-project, reviewed, opt-in domains for APIs the build
            legitimately integrates.
        router_host: the control-plane model router host. This is the *only*
            path from a sandbox to a model (I5); the sandbox never holds a model
            API key and never calls a third-party model API directly.
    """

    categories: tuple[Category, ...] = ()
    extra_allow: frozenset[str] = field(default_factory=frozenset)
    router_host: str | None = None

    #: Fixed. Exposed as an attribute so misconfiguration is impossible, not merely discouraged.
    default_action: Literal["deny"] = "deny"
    log_all_requests: Literal[True] = True

    def __post_init__(self) -> None:
        seen: set[str] = set()
        for category in self.categories:
            if category.name in seen:
                raise PolicyError(f"duplicate egress category {category.name!r}")
            seen.add(category.name)
        for domain in self.extra_allow:
            if domain.lower() in ALWAYS_DENIED_HOSTS:
                raise PolicyError(
                    f"{domain!r} is a provider metadata host and can never be allowlisted (I4)"
                )
            if _is_ip_literal(domain):
                raise PolicyError(
                    f"extra_allow entry {domain!r} is an IP literal; allowlist by domain so "
                    "requests are resolved and logged through the proxy"
                )
            mining = mining_denial(domain.lower())
            if mining is not None:
                raise PolicyError(
                    f"{domain!r} is mining infrastructure ({mining}) and can never be "
                    "allowlisted; no build step legitimately dials a mining pool"
                )

    # -- evaluation ------------------------------------------------------------

    def evaluate(
        self,
        host: str,
        *,
        step: str | None = None,
        resolved_ips: tuple[str, ...] = (),
        port: int | None = None,
    ) -> Decision:
        """Decide whether a sandbox may reach ``host``.

        Args:
            host: the requested hostname or IP literal.
            step: the current build step name. ``"deploy"`` unlocks the
                deploy-target category; any other value leaves it closed.
            resolved_ips: addresses ``host`` resolves to. Supplying these closes
                the DNS-rebinding hole where an allowlisted name points at a
                denied range.
            port: destination port, when known. Stratum ports are denied
                outright, which catches private mining pools that carry no
                recognisable hostname.
        """
        normalised = host.strip().rstrip(".").lower()
        if not normalised:
            return Decision(Verdict.DENY, "empty host")

        # --- I4: unconditional denials, checked before anything else ---------
        if normalised in ALWAYS_DENIED_HOSTS:
            return Decision(Verdict.DENY, "metadata_endpoint")

        # --- abuse infrastructure: never allowlistable ------------------------
        mining = mining_denial(normalised, port)
        if mining is not None:
            return Decision(Verdict.DENY, mining)

        for candidate in (normalised, *resolved_ips):
            denied = _denied_network_for(candidate)
            if denied is not None:
                reason = (
                    "metadata_endpoint"
                    if denied.version == 4 and str(denied).startswith("169.254")
                    else "denied_network"
                )
                return Decision(Verdict.DENY, f"{reason}:{denied}")

        # --- I5: the router is the only sandbox->model path -------------------
        if self.router_host and normalised == self.router_host.lower():
            if self._category_open("model_router", step):
                return Decision(Verdict.ALLOW, "model_router", "model_router")
            return Decision(Verdict.DENY, "model_router category disabled", "model_router")

        # --- categorised allowlist -------------------------------------------
        for category in self.categories:
            domains = CATEGORY_DOMAINS.get(category.name, frozenset())
            if not _host_matches_any(normalised, domains):
                continue
            if not self._category_open(category.name, step):
                return Decision(
                    Verdict.DENY,
                    f"category {category.name} closed for step {step!r}",
                    category.name,
                )
            return Decision(Verdict.ALLOW, f"category:{category.name}", category.name)

        # --- per-project opt-in ----------------------------------------------
        if _host_matches_any(normalised, self.extra_allow):
            if self._category_open("app_apis", step):
                return Decision(Verdict.ALLOW, "extra_allow", "app_apis")
            return Decision(Verdict.DENY, "app_apis category disabled", "app_apis")

        # --- default-deny (I3) ------------------------------------------------
        return Decision(Verdict.DENY, "default_deny")

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


def _denied_network_for(
    value: str,
) -> ipaddress.IPv4Network | ipaddress.IPv6Network | None:
    try:
        address = ipaddress.ip_address(value)
    except ValueError:
        return None
    for network in ALWAYS_DENIED_NETWORKS:
        if address.version == network.version and address in network:
            return network
    return None


def _host_matches_any(host: str, domains: frozenset[str]) -> bool:
    """Match a host against exact domains and single-level ``*.`` wildcards."""
    for domain in domains:
        candidate = domain.lower()
        if candidate.startswith("*."):
            suffix = candidate[1:]  # ".example.com"
            if host.endswith(suffix) and host != suffix.lstrip("."):
                return True
        elif host == candidate or host.endswith(f".{candidate}"):
            return True
    return False
