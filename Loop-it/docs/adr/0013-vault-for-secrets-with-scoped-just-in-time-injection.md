# ADR-0013: Vault for secrets with scoped just-in-time injection

- **Status:** Accepted
- **Date:** 2026-08-23
- **Deciders:** Founding engineering
- **Handbook refs:** `docs/06-control-plane-and-deployment.md` §4
- **Invariants touched:** I2

## Context

Secrets are the sharpest edge in the system. The rule is scoped injection, never broadcast. The sandbox holds no ambient credentials; a build secret is injected only when a specific step genuinely needs a specific key, and expires immediately after. Build and production credentials are firewalled from each other in both directions.

## Decision

We will use HashiCorp Vault (KV v2 + transit) through the in-process `services/secrets-broker` library, which issues short-lived, single-step, single-project leases inside trusted services. Platform infrastructure credentials and model API keys never enter any sandbox. Deployed-app secrets are injected into the deployment plane at deploy time only.

## Alternatives considered

| Option | Pros | Cons | Why not chosen |
|---|---|---|---|
| Cloud-native secret manager | Managed | Ties us to one cloud; self-host promise suffers | Self-hostability is a product promise |
| Environment variables at sandbox boot | Trivial | Ambient credentials - directly violates I2 | Never |
| Encrypted files in the repo | No infra | Rotation and scoping are impossible | Never |

## Consequences

**Positive:** A sandbox escape yields a throwaway VM with no keys and no egress; the build/prod firewall is enforced structurally.

**Negative / accepted costs:** Vault is real operational weight, including unseal and rotation procedures that need runbooks.

## Revisit trigger

Revisit if we commit to a single cloud and its secret manager offers equivalent scoping and lease semantics.
