# ADR-0020: Fly canary deploys before Kubernetes rollouts

- **Status:** Accepted
- **Date:** 2026-09-03
- **Deciders:** Platform engineering
- **Handbook refs:** `PLAN.md` §1, P4-16
- **Invariants touched:** none

## Context

PLAN.md §1 and P4-16 call for Argo Rollouts canaries and one-click rollback. Argo Rollouts is
Kubernetes-only. The current budget deployment target is Fly.io, with per-service Fly configs
already present under `infra/fly/`, so adopting Argo now would require operating a Kubernetes
cluster solely to satisfy the rollout mechanism.

## Decision

We will use Fly.io canary/rolling deploy strategies and GitHub Actions rollback workflows for
the PaaS deployment. We will keep the Argo Rollouts decision as the Kubernetes target if the
platform later moves to a cluster.

## Alternatives considered

| Option | Pros | Cons | Why not chosen |
|---|---|---|---|
| Argo Rollouts on Kubernetes now | Matches PLAN.md text exactly; mature progressive delivery | Requires cluster operations and Helm/Terraform work before traffic justifies it | Rejected for the Fly PaaS budget path |
| Manual Fly deploys | Minimal automation | No release blockers, weak auditability, slow rollback | Rejected |
| Fly canary deploys plus rollback workflow | Uses current platform, supports staged rollout and audited rollback | Less expressive than Argo analysis templates | Chosen for Phase 4 Fly deployment |

## Consequences

**Positive:** Deploys are automated on the current PaaS, release blockers gate images before
rollout, and rollback is available from one workflow dispatch.

**Negative / accepted costs:** Canary analysis relies on Fly health checks and external
observability rather than Argo Rollouts analysis templates.

**Follow-up work:** P4-16, P4-17.

## Revisit trigger

Revisit when Loop-it moves production service deployment from Fly.io to Kubernetes or when Fly
canary controls no longer meet the blast-radius target.
