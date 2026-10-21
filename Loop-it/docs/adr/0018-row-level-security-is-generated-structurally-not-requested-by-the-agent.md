# ADR-0018: Row-level security is generated structurally, not requested by the agent

- **Status:** Accepted
- **Date:** 2026-08-23
- **Deciders:** Founding engineering
- **Handbook refs:** `docs/06-control-plane-and-deployment.md` §8, `docs/05-verification-and-evals.md` (T2)
- **Invariants touched:** I9

## Context

Generated apps share a managed Postgres backend, so one missing tenant filter is a cross-tenant data breach rather than a bug in one app. The handbook is explicit: *"row-level security must be ON by default and generated into every schema — not left to the model to remember."*

The tempting implementation is to teach the planner about RLS and check its output. That fails for a structural reason rather than a quality one: anything the model can be asked to include, prompt injection can ask it to omit. A generated app's own README, a dependency's changelog, or a user-pasted snippet all enter the context window, and the agent cannot reliably distinguish instructions from data. Correctness that depends on the model remembering is not a security control.

## Decision

Schema provisioning goes through `packages/provision`. The agent supplies a `TableSpec` describing *what to store* and an `access` model naming *who owns the rows*. Everything that enforces isolation — the ownership column, its type, its `NOT NULL`, its default, the four per-command policies, the grants — is emitted by the generator from that access model. There is no parameter, anywhere in the public surface, that disables RLS.

Four specifics are load-bearing:

1. **`FORCE ROW LEVEL SECURITY`, not just `ENABLE`.** `ENABLE` exempts the table's owner, and generated apps routinely connect as the role that owns their tables. RLS the application bypasses by construction protects nobody.
2. **`WITH CHECK` on every write, not only `USING`.** `USING` filters rows a statement may see; `WITH CHECK` constrains rows it may produce. `USING` alone lets a user update their own row into another tenant's ownership — a cross-tenant write and a self-inflicted data loss in one statement.
3. **No policy is ever `USING (true)`.** Postgres default-denies a table with RLS enabled and no matching policy, which fails in the safe direction. A permissive policy converts that safe default into a full table scan, so the generator has no code path that emits one.
4. **`REVOKE ALL ... FROM PUBLIC` before granting.** Policies restrict rows, not table access. Without the revoke, a role reaches the table at all and RLS merely narrows rows for a principal who should not have been present.

The agent is forbidden from declaring the ownership column or the primary key itself. If it could, it could declare `user_id` as nullable `text` and silently defeat every policy generated against it.

Enforcement is layered: `assert_secured` checks the generator's own output before any SQL is returned, and an I9 guard in `scripts/check_invariants.py` fails CI if the generator loses `FORCE`, gains a boolean RLS toggle, or if any `.sql` file in the repo creates a table it does not force RLS on.

## Alternatives considered

| Option | Pros | Cons | Why not chosen |
|---|---|---|---|
| Prompt the model to write RLS, verify after | Flexible; no schema DSL | Prompt injection can suppress it; verification must then parse arbitrary SQL | Security that depends on the model remembering is not a control |
| Application-layer `WHERE user_id = ?` only | Simple; no Postgres features needed | One missing filter is a breach; no backstop | Handbook §8 rejects it explicitly |
| Let the agent pass raw DDL through | Maximum expressiveness | Arbitrary SQL runs with migration privileges | Unbounded blast radius |
| RLS on, policies hand-written per app | Tailored | Reintroduces the "remember to" failure per app | Same failure mode, more surface |

## Consequences

**Positive:** Every table in every generated app is default-deny with tenant-scoped policies, and no prompt can change that. The eval harness's T2 tenant-isolation tier has a real invariant to test rather than a hope. Identifier and type allowlists close the DDL injection path at the same time.

**Negative / accepted costs:** The schema surface the agent can express is deliberately narrow — nine column types, a fixed default allowlist, two access models, no composite keys or joins-as-ownership. Apps needing group sharing, soft-delete visibility, or admin override roles are not yet expressible and will need explicit additions to the access-model vocabulary rather than agent creativity. Generated schemas also carry platform-chosen columns (`id`, `created_at`, `updated_at`) whether the app wants them or not.

## Revisit trigger

Revisit when the first legitimate app requirement cannot be expressed by the `owner`/`tenant` access models — most likely group/team sharing. Add a named access model with its own generated policies; do not add an escape hatch.
