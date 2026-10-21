# ADR-0001: Monorepo with pnpm/Turborepo and uv workspaces

- **Status:** Accepted
- **Date:** 2026-08-23
- **Deciders:** Founding engineering
- **Handbook refs:** `docs/09-execution-roadmap.md`
- **Invariants touched:** none

## Context

The platform spans TypeScript (UI, gateway, proxies) and Python (agent harness, orchestration workers, evals). Splitting them into separate repositories would fragment the shared contracts (task DAG schema, tool-call schemas, audit events) that both sides must agree on, and would make atomic cross-cutting changes impossible.

## Decision

We will use a single monorepo containing both language workspaces: pnpm workspaces + Turborepo for TypeScript, and uv workspaces for Python. `packages/contracts` holds the language-neutral JSON Schemas that both sides generate from.

## Alternatives considered

| Option | Pros | Cons | Why not chosen |
|---|---|---|---|
| Polyrepo | Independent release cadence | Contract drift; no atomic cross-language change | Contract drift is the dominant risk in an agent platform |
| Nx | Richer generators | Heavier; more opinionated than needed | Turborepo is sufficient for task orchestration + caching |
| Single language (all TS or all Python) | One toolchain | TS lacks the agent/ML ecosystem; Python is a poor fit for the web UI | Neither language covers both halves well |

## Consequences

**Positive:** Atomic cross-language changes; one CI pipeline; shared schemas cannot drift.

**Negative / accepted costs:** Two toolchains to install and keep current; CI must cache both; contributors need both installed.

## Revisit trigger

Revisit if the Python share of the codebase falls below 10%, or if CI wall-clock exceeds 20 minutes on cached runs.
