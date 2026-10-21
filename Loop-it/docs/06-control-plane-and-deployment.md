# 06 — Control Plane and Deployment

**Purpose:** The agent loop gets the attention, but most of the *product* is the SaaS scaffolding around it — the trusted control plane (API, auth, billing, quota, orchestrator, scheduler, secrets, audit), the project data model with copy-on-write checkpoints and forks, the discipline that governs how secrets reach sandboxes and deployed apps, the deployment plane options, and the reverse-proxy that makes preview URLs safe. This doc specifies all of it, deepening the control-plane and deployment rows of the documentation map in `00-blueprint.md` (§3) and Section 5 of the research playbook. It assumes the four-plane model from `01-architecture-blueprint.md` and the sandbox controls from `02-sandbox-and-isolation.md`.

> **Hard boundary (non-negotiable):** The control plane is **trusted and never runs agent-generated code.** Everything in this doc lives in the control plane *except* the sandbox lease target and the deployed app, which are the data plane and deployment plane respectively. If a design forces you to execute generated code in a control-plane service to make a feature work, the design is wrong — move the execution to the data plane. "Unrestricted" is about model choice, code ownership, and capability breadth; it never means dissolving this boundary.

---

### 1. Control-plane services

The control plane is a set of trusted services. None of them ever executes agent-generated code; they orchestrate, meter, authorize, and record.

| Service | Responsibility | Talks to | Never does |
|---|---|---|---|
| **API / gateway** | Public HTTP/WS surface; authN/authZ on every request; rate limiting | Everything below | Run generated code; trust client-supplied identity |
| **Auth** | Platform user identity, sessions, org/team membership, RBAC | API, project store | Share tenant identity with sandboxes |
| **Billing + quota** | Credits/metering, plan limits, hard/soft quota enforcement | Model router, scheduler, metrics | Let a run exceed quota silently |
| **Orchestrator** | Durable workflow engine driving the agent loop; approval gates; retries; resume-after-crash | Scheduler, model router, sandbox leases | Hold long state in process memory |
| **Scheduler** | Job queue + sandbox placement; warm-pool draw; resource-limit assignment | Sandbox fleet (data plane) | Place two tenants in one sandbox |
| **Model router** | LiteLLM-style routing to inference backends; server-side credential injection; per-tenant quota | Inference backends (`03`) | Expose model API keys to the sandbox |
| **Secrets manager** | Encrypted store; scoped injection to deploy target or a single build step | Deploy plane, scheduler | Broadcast secrets into every sandbox |
| **Audit log** | Append-only record of every action/observation/approval | All services | Allow mutation or deletion |
| **Observability** | Traces, metrics, per-run step traces | All services | Store raw secrets in logs/traces |

**Design rules:**

- **Every request is authenticated and authorized at the API gateway.** Downstream services trust the gateway-issued, signed identity — not client claims.
- **Sandbox RPC is signed, least-privilege, and one-directional in trust:** the control plane issues scoped instructions; the sandbox returns structured results. The sandbox cannot call arbitrary control-plane endpoints.
- **The model router is the only path from a sandbox to a model.** The sandbox never holds a model API key; the router injects credentials server-side and enforces quota. This is what makes model openness safe (see `03-model-layer-and-serving.md`).
- **Audit is append-only** and captures approvals and destructive actions specifically (feeds `08-security-and-abuse-playbook.md`).

---

### 2. Project data model

The minimum viable model, from the playbook, sharpened into entities and the rules that make forks/checkpoints cheap.

```
User (belongs to Org)
 └─ Project
     ├─ Files            (CoW filesystem; snapshots = Checkpoints)
     ├─ Checkpoints      (immutable CoW snapshots of Files [+ project DB])
     ├─ Runs / Jobs      (durable orchestrator executions; each references a base Checkpoint)
     ├─ Sandbox lease    (ephemeral; bound to one Run; destroyed after)
     ├─ Database         (the project's own dev DB, tenant-isolated)
     ├─ Secrets          (scoped; see §4)
     ├─ Deployments      (deploy-plane targets + their own creds)
     ├─ Git remote       (sync target; see §7)
     └─ Connectors       (MCP-style external integrations, per-project scoped)
```

| Entity | Key properties | Lifecycle |
|---|---|---|
| `Project` | id, org_id, owner_id, stack, created_at | Long-lived |
| `Checkpoint` | id, project_id, parent_id, cow_ref, db_snapshot_ref, created_at, label | Immutable; retained per policy |
| `Run` | id, project_id, base_checkpoint_id, status, sandbox_lease_id, cost | Minutes–hours; durable |
| `Sandbox lease` | id, run_id, tenant_id, resource_caps, expires_at | Ephemeral; destroyed on run end |
| `Deployment` | id, project_id, target, url, own_creds_ref, status | Managed separately from build |

**Rules:**

- A `Run` always executes against a **base `Checkpoint`**, never against mutable "current" files directly — this is what makes forks and parallel task agents safe.
- A `Sandbox lease` is bound to exactly one `Run` and one `tenant_id`, has hard resource caps, and expires. No shared sandboxes for untrusted code (see `02-sandbox-and-isolation.md`).

---

### 3. Checkpoints and forks (copy-on-write)

Copy-on-write of the project filesystem — and, where relevant, the project DB — is the mechanism behind cheap forks and instant rollback. It's why Replit-style parallel task agents can run on forked project state affordably.

- **Checkpoint = immutable CoW snapshot.** Creating one copies no data up front; blocks are shared until written. Cheap to take, cheap to keep many.
- **Fork = new mutable working set from a Checkpoint.** Two forks from the same checkpoint share unmodified blocks and diverge only on writes. This makes "run two features in parallel" and "undo the last hour" both affordable — see the parallelism gate in `09-execution-roadmap.md`.
- **DB checkpoints** matter when a task changes schema/data: snapshot the project's dev DB alongside the filesystem so a rollback restores a *consistent* state, not files-without-schema.

**Runbook — checkpoint on every meaningful step:**

1. Before a `Run` starts, snapshot the base state → `Checkpoint(parent=current)`.
2. The run forks a working set from that checkpoint into its sandbox.
3. On a verified-good step (L0–L2 green, see `05-verification-and-evals.md`), take a checkpoint.
4. On failure past the iteration cap, the user (or agent) can roll back to any prior checkpoint — instant, because it's a CoW ref swap.
5. Parallel task agents each fork the same base checkpoint; a verification sub-agent gates merge (see `04-orchestration-and-agent-loop.md`).

**Retention decision rule:** keep all checkpoints for an active project's recent window (default: last 7 days or 50 checkpoints, whichever is larger), then prune to labeled/milestone checkpoints. Never auto-prune a checkpoint referenced by an open Run. Recovery from checkpoints is covered operationally in `07-operations-runbook.md`.

---

### 4. Secrets discipline (injection rules)

Secrets are the sharpest edge in the system. The rule is **scoped injection, never broadcast.**

#### 4.1 Where secrets live and how they move

| Secret class | Stored in | Injected into | When | Never reaches |
|---|---|---|---|---|
| Platform infra creds (cloud, DB admin) | Control-plane secrets manager | Control-plane services only | N/A | Any sandbox, ever |
| Model API keys | Secrets manager | Model router only (server-side) | Per request | The sandbox |
| Deployed-app secrets (prod DB, Stripe live, etc.) | Secrets manager | The **deployed app** | Deploy time | The build sandbox |
| Build-step secrets (a specific registry token, one API key a build genuinely needs) | Secrets manager | The sandbox, scoped to one step | Only for that step, then revoked/expired | Other steps, other projects |

#### 4.2 Injection rules (do this / don't do this)

- **DO** inject deployed-app secrets into the deployment plane at deploy time — and only there.
- **DO** inject a build secret into a sandbox **only when a specific step genuinely needs a specific key**, scoped and short-lived.
- **DON'T** put platform cloud keys, DB admin creds, or another tenant's secrets in any sandbox. There are **no ambient credentials in the sandbox** (see `02-sandbox-and-isolation.md`).
- **DON'T** hand model API keys to the sandbox — it reaches models only via the router.
- **DON'T** write secrets into generated client-side code, logs, traces, or checkpoints. Scan generated output for leaked secrets as part of the security-analyzer pass (`08-security-and-abuse-playbook.md`).
- **DON'T** reuse a build sandbox's identity for deploy. Build and deploy have **separate** credentials.

#### 4.3 The build↔prod firewall

The deployed app gets its **own** database, auth, storage, and secrets, fully separate from the build sandbox. A compromised build must never reach production data; a compromised prod must never reach the build plane. This bidirectional separation is a security invariant, not a convenience.

---

### 5. Deployment plane

One explicit deploy action, with its own credentials. Options in rough order of how much the platform operates vs. the user:

| Option | Who operates it | Best for | Creds source | Trade-off |
|---|---|---|---|---|
| **Managed hosting** (you run it) | Platform | Non-technical users; fastest path | Platform-managed, per-project | Most control for you; you carry the ops |
| **Push-to-Git + provider CI/CD** (Vercel/Railway/Fly/Cloudflare) | Provider | Users who want portability | User's provider account or platform-brokered | Provider ToS applies (`10-governance-legal-policy.md`) |
| **User's own cloud** | User | Enterprise, self-host, VPC | User's cloud credentials | Max ownership; you support less |

**Rules:**

- Deploy is **one explicit action**, never an implicit side effect of a build. Destructive/irreversible deploy steps pass through a confirmation gate.
- Each `Deployment` has its **own creds ref** (§4). Build creds are never valid for deploy.
- Code ownership is a first-class product promise (the "unrestricted" openness dimension): every project can export to Git and self-host. No lock-in.

---

### 6. Preview URL auth via reverse proxy

A preview URL serves a running, agent-generated app. An **unauthenticated preview is a data leak waiting to happen** — and a raw open port on a sandbox is worse.

**Architecture:**

```
User browser ──HTTPS──► Preview reverse proxy (control-plane edge)
                          │  - authenticates the request (platform session / signed token)
                          │  - authorizes: does this user own/collaborate on this project?
                          │  - maps project-id ─► current sandbox lease
                          ▼
                    Sandbox preview server (data plane, no public port)
```

**Rules (do this / don't do this):**

- **DO** serve every preview through the authenticated, per-project reverse proxy. The sandbox's preview server has **no publicly reachable port**.
- **DO** authorize per project on every request — session or short-lived signed URL scoped to one project and expiring.
- **DON'T** expose raw sandbox ports to the internet.
- **DON'T** issue a preview link that works without auth, even "temporarily."
- The proxy is also the entry point the in-sandbox Playwright browser hits during verification (`05-verification-and-evals.md`), so the verified path and the user-viewed path are identical.

---

### 7. Git sync, environment, and config management

#### 7.1 Git sync

- Each project may bind a **Git remote**; the platform pushes commits (checkpoint-aligned where sensible) and can pull. This underwrites code ownership and no lock-in.
- Parallel task agents may work on **Git branches** as an alternative to CoW forks for merge-oriented workflows (`04-orchestration-and-agent-loop.md`); a verification sub-agent gates the merge.
- Git credentials are per-project, scoped, stored in the secrets manager (§4), and never left in the sandbox beyond the step that needs them.

#### 7.2 Environment and config management

- **Distinct environments:** `dev` (the project's build DB/config, used by the sandbox) and `prod` (the deployed app's own DB/config). Promotion from dev to prod is explicit and passes through deploy.
- **Config, not secrets, in the repo.** Non-secret config (feature flags, public URLs) can live in versioned config; secrets never do (§4).
- **Per-environment secret sets** in the secrets manager, injected only into their matching plane.

---

### 8. Multi-tenancy: RLS-by-default for managed backends

Multi-tenancy is enforced by namespace isolation + network policies + per-tenant credentials + no shared sandboxes for untrusted code (`02-sandbox-and-isolation.md`). For the **managed shared backend** that generated apps use (shared Postgres/auth/storage), one rule dominates:

> **Row-level security must be ON by default and generated into every schema — not left to the model to remember.**

**Rules:**

- **DO** generate RLS policies into every table of a managed-backend schema automatically. The platform's provisioning tools emit RLS; the agent does not have to remember to.
- **DO** default-deny: a table with RLS enabled and no matching policy returns nothing, rather than everything.
- **DO** verify tenant isolation in the eval harness (T2 tier, `05-verification-and-evals.md`): user A must not read user B's rows.
- **DON'T** rely on application-layer `WHERE user_id = ?` filters as the only guard — one missing filter is a cross-tenant breach. RLS is the backstop.
- **DON'T** ship a managed schema with RLS off "for now."

---

### 9. Control-plane & deployment checklist

- [ ] No control-plane service ever executes agent-generated code.
- [ ] Every API request authenticated + authorized at the gateway; downstream trusts signed identity only.
- [ ] Sandbox RPC is signed, least-privilege, one-directional in trust.
- [ ] Model router is the sole sandbox→model path; keys injected server-side.
- [ ] Data model: Runs execute against immutable base Checkpoints; leases are per-tenant, ephemeral, capped.
- [ ] CoW checkpoints taken on verified-good steps; DB snapshotted with files; rollback is a ref swap.
- [ ] Secrets scoped-injected, never broadcast; build↔prod firewall enforced; no ambient creds in sandbox.
- [ ] Deploy is one explicit action with its own creds; build creds never valid for deploy.
- [ ] Previews served only through the authenticated per-project reverse proxy; no raw sandbox ports.
- [ ] Git sync + per-project scoped credentials; dev/prod environments distinct.
- [ ] Managed-backend schemas ship with RLS on by default, generated automatically, verified in evals.

---

### 10. Cross-references

- `00-blueprint.md` — master index; research playbook Section 5 (control plane, projects, deployment).
- `01-architecture-blueprint.md` — the four planes and the cardinal execution rule.
- `02-sandbox-and-isolation.md` — sandbox leases, no ambient creds, egress, metadata block, tenant isolation.
- `03-model-layer-and-serving.md` — inference backends behind the router; credential injection.
- `04-orchestration-and-agent-loop.md` — durable orchestrator, approval gates, parallel forks/branches.
- `05-verification-and-evals.md` — verification hits the preview proxy; checkpoints reproduce runs; RLS verified in T2.
- `07-operations-runbook.md` — backup/restore, checkpoint recovery, deploy rollout/rollback.
- `08-security-and-abuse-playbook.md` — audit log, secret-leak scanning, confirmation gates.
- `10-governance-legal-policy.md` — provider/processor ToS for deploy targets; data handling.
