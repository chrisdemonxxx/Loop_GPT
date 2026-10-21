# ADR-0002: Fastify + tRPC + OpenAPI for the control-plane API

- **Status:** Accepted
- **Date:** 2026-08-23
- **Deciders:** Founding engineering
- **Handbook refs:** `docs/06-control-plane-and-deployment.md` §1
- **Invariants touched:** I1, I10

## Context

The control plane is trusted and must authenticate and authorize every request at the gateway, with downstream services trusting only the gateway-issued signed identity. We need a typed internal surface for our own web UI and a stable, documented public surface for API clients and CI integrations.

## Decision

We will build `apps/api` on Fastify, exposing tRPC for first-party clients (type-sharing with `apps/web`) and a generated OpenAPI 3.1 surface for third-party clients. Both surfaces pass through the same auth, rate-limit, and audit middleware.

## Alternatives considered

| Option | Pros | Cons | Why not chosen |
|---|---|---|---|
| Express | Ubiquitous | Slower; weaker schema/validation story | Fastify's JSON Schema validation aligns with our contracts-first approach |
| NestJS | Batteries included | Heavy DI framework; slower cold start | Complexity not justified for a gateway |
| Go service | Performance | Loses type-sharing with the web UI | Type-sharing is worth more than raw throughput at the gateway |

## Consequences

**Positive:** One middleware chain guarantees auth + audit on every route (I10); end-to-end types for the UI; OpenAPI is generated, not hand-maintained.

**Negative / accepted costs:** Two API surfaces to keep in sync; tRPC is not a public-facing standard.

## Revisit trigger

Revisit if third-party API usage exceeds first-party, or if gateway p99 latency becomes a bottleneck.
