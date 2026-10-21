# ADR-0011: One opinionated generated-app stack: React/Vite/Tailwind + Postgres/auth/storage

- **Status:** Accepted
- **Date:** 2026-08-23
- **Deciders:** Founding engineering
- **Handbook refs:** `docs/09-execution-roadmap.md` §4, `docs/06-control-plane-and-deployment.md` §8
- **Invariants touched:** I9

## Context

Opinionation is a feature, not a limitation. A narrow, deeply-supported stack produces far higher success rates than a general agent that can theoretically do anything and reliably does nothing. It also shrinks the planner's task vocabulary to a small, reliable set.

## Decision

We will support exactly one stack, deeply: React + Vite + TypeScript + Tailwind + shadcn/ui on the frontend, and Postgres with a generated REST/RPC API, GoTrue-compatible auth, and S3-compatible storage on the backend. Provisioning tools emit row-level security into every table automatically. A second stack is considered only after the first reaches its target success rate.

## Alternatives considered

| Option | Pros | Cons | Why not chosen |
|---|---|---|---|
| General-purpose any-stack agent | Broad appeal | Low reliability; the product-killing risk R8 | Explicitly rejected by the handbook |
| Two stacks from the start | Wider market | Halves the depth of support for each | Depth first |
| Next.js instead of Vite | Popular; SSR | Heavier surface for the agent to get right; deploy coupling | Revisit as the second stack |

## Consequences

**Positive:** Higher success rate; smaller planner vocabulary; provisioning tools can guarantee RLS-by-default (I9).

**Negative / accepted costs:** Some users will want a stack we do not support until Phase 5.

## Revisit trigger

Revisit when T1 and T2 eval success rates are at target and stable for a full quarter.
