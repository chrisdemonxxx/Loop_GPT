# ADR-0003: Temporal as the durable workflow engine

- **Status:** Accepted
- **Date:** 2026-08-23
- **Deciders:** Founding engineering
- **Handbook refs:** `docs/04-orchestration-and-agent-loop.md` §1
- **Invariants touched:** I7, I12

## Context

Agent runs last minutes to hours and must survive process restarts: a crash must resume, not lose an hour of work. Runs also need principled bounded retries, durable pause-for-human-approval that holds no process and no sandbox lease, and a step history that doubles as an audit trace.

## Decision

We will adopt Temporal. A `Run` is a durable workflow instance; sandbox interactions are activities with their own timeouts; confirmation gates are durable signals. We will not hand-roll durability.

## Alternatives considered

| Option | Pros | Cons | Why not chosen |
|---|---|---|---|
| Custom event-sourced runner | Full control | Months of subtle bug-hunting on retries, timers, idempotency | Handbook Doc 04 is explicit: do not hand-roll durability |
| Celery / BullMQ | Familiar | Task queues, not durable workflows; no first-class signals/timers/resume | Wrong primitive |
| AWS Step Functions | Managed | Cloud lock-in; poor local dev; awkward for long agent loops | Self-hostability is a product promise (VPC/self-host in Phase 5) |

## Consequences

**Positive:** Crash-resume for free; retries and human gates are first-class; workflow history is a ready-made trace.

**Negative / accepted costs:** Operational weight of a Temporal cluster; workers must be written to be deterministic; a new concept for contributors.

## Revisit trigger

Revisit only if Temporal's licensing changes materially or self-hosting cost becomes disproportionate. Re-verify SDK APIs at implementation time — they are time-sensitive.
