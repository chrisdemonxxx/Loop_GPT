# ADR-0017: Terraform, Helm, and canary rollouts with one-click rollback

- **Status:** Accepted
- **Date:** 2026-08-23
- **Deciders:** Founding engineering
- **Handbook refs:** `docs/07-operations-runbook.md` §7
- **Invariants touched:** none

## Context

A platform that runs untrusted code for paying tenants needs reproducible environments, a safe rollout path, and a rollback that is faster than a fix. Configuration drift between staging and production would invalidate every pre-production red-team result.

## Decision

We will define all infrastructure in Terraform and all service deployments in Helm across `dev`, `staging`, and `prod`, and roll out via Argo Rollouts canaries with automated rollback on golden-signal regression. Runbooks live in `infra/runbooks/` as executable checklists.

## Alternatives considered

| Option | Pros | Cons | Why not chosen |
|---|---|---|---|
| Manual/console infrastructure | Fast initially | Drift; unreproducible; red-team results do not transfer | Rejected |
| Plain kubectl deploys | Simple | No progressive delivery or automated rollback | Insufficient for Phase 4 |
| Full GitOps from day one | Auditable | Extra machinery before there is anything to deploy | Adopt incrementally |

## Consequences

**Positive:** Environments are reproducible; a bad release is contained to the canary; rollback is a documented, practiced action.

**Negative / accepted costs:** Terraform and Helm expertise required on the team; more moving parts in CI.

## Revisit trigger

Revisit if the deployment surface consolidates onto a single managed platform.
