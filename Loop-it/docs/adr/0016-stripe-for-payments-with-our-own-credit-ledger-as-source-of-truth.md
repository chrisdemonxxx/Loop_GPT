# ADR-0016: Stripe for payments with our own credit ledger as source of truth

- **Status:** Accepted
- **Date:** 2026-08-23
- **Deciders:** Founding engineering
- **Handbook refs:** `docs/06-control-plane-and-deployment.md` §1
- **Invariants touched:** I12

## Context

Quota must be enforced before a sandbox is leased or a token is spent, and metering originates in our router and scheduler, not in the payment processor. Payment-processor acceptable-use terms must also be confirmed compatible with our model stance before we take money.

## Decision

We will use Stripe for payment collection while keeping an internal credit ledger as the authoritative record of metered usage and balance. The ledger is debited from router and scheduler metering events and reconciled against Stripe, never the reverse.

## Alternatives considered

| Option | Pros | Cons | Why not chosen |
|---|---|---|---|
| Stripe as source of truth | Less code | Cannot enforce pre-spend quota; usage originates with us | Wrong direction of truth |
| Usage-based billing SaaS | Turnkey metering | Another dependency between us and revenue | Revisit at scale |
| No metering until launch | Faster early | Cost-per-successful-deploy is unmeasurable, and it is the north-star KPI | Metering starts in Phase 1 |

## Consequences

**Positive:** Hard quota enforcement before spend (I12); cost-per-successful-deploy is computable end to end; processor is replaceable.

**Negative / accepted costs:** We own reconciliation logic and its failure modes.

## Revisit trigger

Revisit before taking the first payment - ticket G-3 must confirm processor AUP compatibility. Re-verify processor terms annually.
