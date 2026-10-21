# ADR-0010: CoW checkpoints persisted off the sandbox VM

- **Status:** Accepted
- **Date:** 2026-08-23
- **Deciders:** Founding engineering
- **Handbook refs:** `docs/02-sandbox-and-isolation.md` §4, `docs/06-control-plane-and-deployment.md` §3
- **Invariants touched:** I1

## Context

Copy-on-write is what makes forks, parallel task agents, and undo-the-last-hour affordable. Sandboxes are cattle: they are destroyed after every run, so durable state cannot live on the VM.

## Decision

We will store the project filesystem as a copy-on-write snapshot tree (immutable `Checkpoint` records with `parent_id`) in data-plane storage, never on the sandbox VM. Runs always execute against an immutable base checkpoint. Project DB state is snapshotted alongside files so rollback restores a consistent state.

## Alternatives considered

| Option | Pros | Cons | Why not chosen |
|---|---|---|---|
| Git-only history | Familiar | Does not capture DB state, node_modules, or build artifacts; merge semantics wrong for parallel agents | Git sync is offered in addition, not instead |
| Full copies per checkpoint | Simple | Storage cost makes frequent checkpoints unaffordable | CoW is what makes them cheap |
| Keep state on a long-lived VM | Convenient | Cross-tenant leak risk; contradicts ephemerality | Never |

## Consequences

**Positive:** Cheap forks and instant rollback (a ref swap); parallel agents get isolated views of the same base; nothing green is ever lost to a crash.

**Negative / accepted costs:** Storage engine choice (ZFS/btrfs vs object-store deltas) is a real engineering commitment; snapshot pruning policy needed.

## Revisit trigger

Revisit the storage backend if checkpoint create latency exceeds 2s p95 or storage cost per project exceeds budget.
