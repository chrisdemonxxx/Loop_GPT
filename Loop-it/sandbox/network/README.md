# Sandbox network isolation

`sandbox/network` is the packet-level data-plane guardrail for invariants I3,
I4 and I5:

1. the sandbox provider firewall creates an isolated network;
2. the in-sandbox nftables ruleset defaults all output to `drop`;
3. HTTP(S) can only reach `services/egress-proxy`, which performs category
   allowlisting and full audit logging;
4. model traffic reaches only `router-svc`; and
5. cloud metadata/link-local ranges are blocked before any private-network
   exception.

The layers are defense in depth. The egress proxy knows hostnames and categories
(`package_registries`, `model_router`, reviewed app APIs, deploy targets). The
nftables layer knows packets and therefore closes bypasses: direct IP egress,
alternate DNS resolvers, RFC1918/provider fabric, and metadata endpoints such as
`169.254.169.254`, ECS `169.254.170.2`, `fd00:ec2::254`, and GCP
`metadata.google.internal` after it resolves.

## Files

- `nftables/sandbox.nft` — complete commented nftables policy with
  environment variables at the top.
- `docker/` — DockerProvider development wiring: internal-only network and
  proxy-pinned environment. Docker mode is not the security boundary.
- `src/loopit_sandbox_network/` — typed renderer and validation helpers.
- `tests/` — static pytest coverage; no root privileges or `nft` binary needed.

## Rendering

```python
from loopit_sandbox_network import Endpoint, NetworkPolicyConfig, render_nftables

rules = render_nftables(
    NetworkPolicyConfig(
        egress_proxy=Endpoint("10.255.0.10", 3128),
        resolver=Endpoint("10.255.0.53", 53),
        router=Endpoint("10.255.0.20", 443),
    )
)
```

Rendering fails closed if the default policy is not `deny`, metadata blocking is
disabled, required metadata ranges are missing, or a trusted endpoint points at
link-local/metadata space.

## Red-team verification

`evals/redteam/test_egress_and_metadata.py` verifies the egress proxy semantics:
metadata hosts/ranges deny unconditionally, DNS rebinding into metadata fails,
unlisted destinations default-deny, and third-party model APIs are not reachable.

`loopit_sandbox_network.verification_probes()` returns the live packet-level
negative probes future provider checks should run from inside each sandbox:

- metadata HTTP to `169.254.169.254` and `fd00:ec2::254` must fail;
- direct public HTTPS by IP must fail;
- DNS to any resolver other than the configured resolver must fail.

Those probes complement the static tests here and the egress proxy policy tests.
