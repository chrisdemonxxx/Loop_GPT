# ADR-0008: Buy a managed Firecracker sandbox provider now; evaluate self-hosting in Phase 4

- **Status:** Accepted
- **Date:** 2026-08-23
- **Deciders:** Founding engineering
- **Handbook refs:** `docs/02-sandbox-and-isolation.md` §1, `docs/09-execution-roadmap.md` §3
- **Invariants touched:** I1, I2, I3, I4

## Context

Untrusted, agent-generated code needs microVM-grade isolation from day one. Self-hosting Firecracker means weeks of KVM and host engineering that Phase 1 cannot afford. Bare shared-kernel Docker is not a phase, it is a dead end: one kernel CVE is a full host compromise.

## Decision

We will integrate a managed Firecracker-based sandbox provider for Phases 0-3, and enforce default-deny egress, the metadata-endpoint block, resource caps, and no-ambient-credentials ourselves on top of the provider from day one. We will re-evaluate self-hosted Firecracker at Phase 4 when density and margin justify the host engineering.

## Alternatives considered

| Option | Pros | Cons | Why not chosen |
|---|---|---|---|
| Self-hosted Firecracker now | Full egress/metadata control; cheaper when dense | Weeks of KVM/host engineering | Wrong phase |
| gVisor on containers | Fast to ship | Syscall-compat gaps; weaker boundary | Acceptable only as explicitly temporary debt with a migration ticket |
| Bare Docker | Fastest | Shared kernel; unacceptable for untrusted multi-tenant code | Never |

## Consequences

**Positive:** Days to integrate; the provider carries the boot-time and density figures; isolation discipline becomes muscle memory early.

**Negative / accepted costs:** Per-use premium; some egress control is the provider's to deliver, so we verify it with our own red-team suite rather than trusting it.

## Revisit trigger

Revisit at the Phase 4 build-vs-buy review with real volume data, or immediately if a provider red-team check fails.
