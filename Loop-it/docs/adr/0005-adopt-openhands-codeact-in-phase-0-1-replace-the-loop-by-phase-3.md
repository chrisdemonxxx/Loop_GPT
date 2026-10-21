# ADR-0005: Adopt OpenHands (CodeAct) in Phase 0-1, replace the loop by Phase 3

- **Status:** Accepted
- **Date:** 2026-08-23
- **Deciders:** Founding engineering
- **Handbook refs:** `docs/09-execution-roadmap.md` §2
- **Invariants touched:** I1, I6

## Context

Phase 0's goal is to prove the loop exists at all, in one to two weeks. Writing an agent loop from scratch at that stage burns the entire phase budget. But by Phase 3 the loop must be driven by Temporal, with a task DAG, CoW forks, and merge gating that no off-the-shelf harness provides.

## Decision

We will adopt OpenHands' CodeAct harness for Phases 0-1 to reach the first gate quickly, while keeping our own tool schemas in `packages/contracts` so the tools survive the swap. By Phase 3 we replace the loop itself with our Temporal-driven loop and retain the tools.

## Alternatives considered

| Option | Pros | Cons | Why not chosen |
|---|---|---|---|
| Build our own loop from day one | No migration later | Blows the Phase 0 budget | Gate is a working loop, not an elegant one |
| Stay on OpenHands permanently | No migration cost | Cannot express durable DAG + CoW forks + merge gating | Phase 3 gate is unreachable |
| LangGraph | Graph-native | Still not durable across restarts; another abstraction to fight | Temporal already provides durability |

## Consequences

**Positive:** Fast Phase 0 exit; tools are written once against our own schemas.

**Negative / accepted costs:** A planned rewrite of the loop in Phase 3 (ticket P3-2); temporary dependency on an external harness's conventions.

## Revisit trigger

Revisit at the Phase 2 exit gate — confirm the migration is still the right call before starting P3-2.
