# ADR-0007: LiteLLM behind our own router-svc

- **Status:** Accepted
- **Date:** 2026-08-23
- **Deciders:** Founding engineering
- **Handbook refs:** `docs/03-model-layer-and-serving.md` §2
- **Invariants touched:** I5

## Context

The sandbox must never hold a model API key, quota must be enforced before tokens are spent, every model call must be costed and audited, and models must stay swappable so we never lock to one. LiteLLM solves provider normalization but not our quota, cost-attribution, or audit requirements.

## Decision

We will run LiteLLM as the provider-normalization layer and wrap it in our own `services/router-svc`, which owns task-difficulty routing policy, per-tenant quota enforcement, server-side credential injection, cost attribution, and audit emission. `router-svc` is the sole sandbox-to-model path.

## Alternatives considered

| Option | Pros | Cons | Why not chosen |
|---|---|---|---|
| LiteLLM alone | Less code | No per-tenant quota, cost attribution, or audit hooks we control | Insufficient for the invariants |
| Fully custom router | Total control | Re-implementing provider quirks forever | LiteLLM absorbs that churn |
| Direct provider SDKs | Simplest | Hard-codes a model; breaks swappability | Contradicts the product thesis |

## Consequences

**Positive:** Models are a config change; keys never leave the control plane (I5); every token is attributed to a tenant and a run.

**Negative / accepted costs:** An extra hop on every model call; we own the routing policy's correctness.

## Revisit trigger

Revisit if LiteLLM's normalization stops keeping pace, or if router latency becomes material at p99.
