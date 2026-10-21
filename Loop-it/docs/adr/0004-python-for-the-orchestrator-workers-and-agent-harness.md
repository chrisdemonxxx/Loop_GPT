# ADR-0004: Python for the orchestrator workers and agent harness

- **Status:** Accepted
- **Date:** 2026-08-23
- **Deciders:** Founding engineering
- **Handbook refs:** `docs/04-orchestration-and-agent-loop.md`
- **Invariants touched:** I1

## Context

The agent harness needs constrained/structured decoding, tokenizer access, retrieval, and eval tooling. That ecosystem is overwhelmingly Python. The orchestrator runs entirely in the control plane and never executes agent-generated code.

## Decision

We will write `services/orchestrator` and `packages/agent-core|tools|patch|sandbox-sdk` in Python 3.11+ using the Temporal Python SDK.

## Alternatives considered

| Option | Pros | Cons | Why not chosen |
|---|---|---|---|
| TypeScript workers | One language with the gateway | Weaker LLM/eval ecosystem | Ecosystem gap is decisive |
| Go workers | Performance, easy deploys | Weakest agent ecosystem | Same reason |

## Consequences

**Positive:** Best-in-class tooling for the part of the system where most engineering effort goes.

**Negative / accepted costs:** Second runtime in CI and in production images; strict typing requires mypy discipline.

## Revisit trigger

Revisit if the harness becomes I/O-bound orchestration only, with model interaction fully behind the router.
