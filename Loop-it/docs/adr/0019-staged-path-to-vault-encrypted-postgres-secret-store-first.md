# ADR-0019: Staged path to Vault: encrypted Postgres secret store first

- **Status:** Accepted
- **Date:** 2026-09-03
- **Deciders:** Founding engineering
- **Handbook refs:** `docs/06-control-plane-and-deployment.md` §4, `PLAN.md` §1
- **Invariants touched:** I2, I10

## Context

ADR-0013 chose HashiCorp Vault because secrets need scoped, just-in-time injection,
short leases, rotation, and a structural build↔prod firewall. That remains the
target design, but operating Vault correctly at launch adds cost and runbook
weight we cannot afford on the minimal-budget path.

The immediate risk is not the broker contract: `services/secrets-broker` already
refuses platform-owned classes, partitions build/preview/prod stores, issues
short leases, redacts values, and audits decisions. The gap is persistence:
launching with only an in-memory plaintext store would make restarts lose user
secrets and would leave stored values unencrypted.

## Decision

We will stage the Vault adoption. For launch, `services/secrets-broker` stores
project secrets in the shared Postgres `secrets` table as opaque encrypted blobs.
Each secret gets a fresh data key; AES-GCM encrypts the value with AAD binding
tenant, project, environment, and name; the data key is AES-GCM-wrapped by a
32-byte root key loaded from `LOOPIT_SECRETS_ROOT_KEY` with an explicit root key
id. The broker-facing `SecretStore` semantics stay unchanged, and the in-memory
store remains the default when no Postgres DSN is configured.

Root-key rotation re-wraps data keys under a new root key without decrypting
secret plaintext into storage. A `VaultSecretStore` adapter remains in-tree as
the migration seam, but does not import or depend on Vault until the cut-over.

## Alternatives considered

| Option | Pros | Cons | Why not chosen |
|---|---|---|---|
| Operate Vault at launch | Matches ADR-0013 immediately | Unseal, HA, backups, and rotation procedures exceed launch budget | Deferred, not rejected |
| Keep only in-memory storage | Simple and already tested | Loses secrets on restart; unencrypted at rest | Not acceptable for launch |
| Store plaintext in Postgres temporarily | Fastest persistence path | Violates the security contract and creates avoidable breach impact | Never |
| Cloud-native secret manager | Managed operations | Weakens self-hostability and ties launch to one cloud | Same objection as ADR-0013 |

## Consequences

**Positive:** Launch preserves no ambient sandbox credentials, project-only
secret classes, build/preview/prod partitioning, short broker leases, redaction,
audited decisions, encrypted-at-rest persistence, AAD replay resistance, and
root-key rotation.

**Deferred costs:** Vault's operational controls, policy engine, dynamic secrets,
transit audit trail, and mature seal/unseal workflows are deferred. The Postgres
root key must be supplied by deployment configuration and protected outside the
database.

## Revisit trigger

Migrate to Vault when secrets volume or compliance requirements demand external
key custody, dynamic credentials, independent transit audit trails, or when the
monthly platform budget can absorb Vault operations without crowding out launch
reliability work.
