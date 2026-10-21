# ADR-0009: Default-deny egress through a logging forward proxy

- **Status:** Accepted
- **Date:** 2026-08-23
- **Deciders:** Founding engineering
- **Handbook refs:** `docs/02-sandbox-and-isolation.md` §5
- **Invariants touched:** I3, I4

## Context

Egress control is the single highest-leverage security measure and the one most often skipped. It neutralizes exfiltration, command-and-control, and abuse-as-a-service simultaneously. Monitoring without blocking is how you learn about the botnet from the abuse report.

## Decision

We will deny all outbound traffic from sandboxes by default and allow only categorized destinations - package registries, our own router, explicitly chosen per-project app APIs, and deploy/Git targets at deploy time only - resolved through a logging forward proxy (`services/egress-proxy`). Link-local and metadata ranges are dropped at the packet level and verified fail-closed.

## Alternatives considered

| Option | Pros | Cons | Why not chosen |
|---|---|---|---|
| Allow-all with monitoring | No build breakage | Detects abuse only after it happens | Rejected explicitly by the handbook |
| IP allowlist | Simple | Registries use rotating CDN IPs; no request-level forensics | Domain/category allowlisting at a proxy is both stricter and more usable |
| Per-project custom rules only | Flexible | No safe default | Default-deny must be the baseline |

## Consequences

**Positive:** Most exfiltration and abuse scenarios have nowhere to send data; every outbound request is logged for forensics; registry caching speeds builds.

**Negative / accepted costs:** Legitimate builds occasionally need a new allowlist category, requiring a reviewed change; the proxy is on the critical path of every build.

## Revisit trigger

Never revisit the default-deny posture. Allowlist categories are revisited continuously via a reviewed change process.
