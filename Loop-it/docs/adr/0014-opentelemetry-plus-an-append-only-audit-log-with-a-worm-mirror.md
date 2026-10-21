# ADR-0014: OpenTelemetry plus an append-only audit log with a WORM mirror

- **Status:** Accepted
- **Date:** 2026-08-23
- **Deciders:** Founding engineering
- **Handbook refs:** `docs/07-operations-runbook.md`, `docs/08-security-and-abuse-playbook.md` §6
- **Invariants touched:** I10

## Context

Every agent action, observation, tool call, model call with cost, and gate decision must be recorded. This log is simultaneously the debugging substrate, the billing substrate, and the abuse-forensics substrate. Forensics requires that it cannot be mutated or deleted, including by us.

## Decision

We will emit OpenTelemetry traces and metrics to a Grafana stack for operational telemetry, and write a separate append-only audit stream to a partitioned Postgres table mirrored to write-once object storage. No service ever writes raw secrets to either.

## Alternatives considered

| Option | Pros | Cons | Why not chosen |
|---|---|---|---|
| Traces as the audit log | One system | Sampled and mutable; retention tuned for ops, not forensics | Audit must be complete and immutable |
| Audit log only | Simpler | No latency/throughput visibility for operations | Both are needed for different questions |
| Vendor APM only | Turnkey | Cost at trace-every-agent-step volume; data residency | Self-hostable stack preferred |

## Consequences

**Positive:** Every run is replayable; abuse investigations have complete evidence; billing reconciles against a source of truth.

**Negative / accepted costs:** Two telemetry paths to instrument; storage growth needs a retention policy per data class.

## Revisit trigger

Revisit retention and storage tiering annually, or when audit storage exceeds its budget line.
