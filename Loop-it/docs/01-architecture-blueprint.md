# 01 — Architecture Blueprint

**Purpose.** This is the reference architecture for an open, self-hosted, model-unrestricted AI software-building platform: a Replit/Lovable-class agentic app builder running on open-weight models. It defines the four planes, the eight layers, component responsibilities, trust boundaries, the data flow of a full build run, technology choices with alternatives, and the minimum viable data model. It is the structural spine that the sibling docs (`02-sandbox-and-isolation.md` through `10-governance-legal-policy.md`) fill in. Read `00-blueprint.md` first for the master framing; this doc turns that framing into buildable structure.

---

### 0. The one rule that shapes everything

**Agent-generated code executes only in the data plane, never in the control plane.** Every catastrophic incident in this product class traces back to a violation of that rule. "Unrestricted" in this platform means three specific things — open model choice, code ownership, and capability breadth — layered *on top of* a hardened execution substrate. It never means removing sandbox isolation, tenant separation, egress controls, or abuse detection. An uncensored model layer sits on a hardened execution layer; the two are orthogonal (see `03-model-layer-and-serving.md` and `02-sandbox-and-isolation.md`).

Bake this into every design review with one question: *"Where does this code run, and is that the data plane?"* If generated code can influence anything in the control plane, the design is wrong.

---

### 1. The four planes

The system is partitioned into four planes with strictly one-directional trust. Higher planes never trust lower planes; lower planes reach higher planes only through narrow, authenticated, least-privilege interfaces.

| Plane | Trust | Runs generated code? | Lifetime | Owns |
|---|---|---|---|---|
| **Control plane** | Trusted | **Never** | Long-lived | API, auth, billing, quota, orchestrator, scheduler, model router, secrets, audit, observability |
| **Data plane** | Untrusted | **Yes** (this is its job) | Ephemeral, per-project/fork | Sandbox microVMs, project CoW filesystem, headless browser, preview proxy |
| **Deployment plane** | Semi-trusted (user's) | Yes (the shipped app) | Persistent (user-owned) | The running user app + its own DB/auth/storage/secrets |
| **User-app plane** | Untrusted end-users | Yes (app logic) | Per request | End users of the shipped app; distinct from platform tenants |

Distinguishing the **deployment plane** (the user's running app) from the **user-app plane** (the end users of that app) matters because their threat models differ: the deployment plane is a tenant-isolation problem for you; the user-app plane is an app-security problem you help the generated app get right (RLS on by default, parameterized queries — see `08-security-and-abuse-playbook.md`).

---

### 2. Trust boundaries (ASCII)

```
                         ┌──────────────────────────────────────────────┐
   Browser / API client  │  Users, CI, external callers                 │
              │          └──────────────────────────────────────────────┘
              │ HTTPS + platform auth (per-tenant)
==============▼==================================================================
 ║ CONTROL PLANE  (trusted — NEVER executes agent-generated code)               ║
 ║  ┌────────────┐  ┌───────────────────┐  ┌───────────────┐  ┌──────────────┐ ║
 ║  │ API / Auth │  │ Orchestrator      │  │ Model Router  │  │ Secrets Mgr  │ ║
 ║  │ Billing    │  │ (durable workflow)│  │ (LiteLLM-like)│  │ Audit / Obs  │ ║
 ║  │ Quota      │  │ Job queue + sched │  │ task routing  │  │              │ ║
 ║  └────────────┘  └─────────┬─────────┘  └──────┬────────┘  └──────────────┘ ║
==============================│===================│=============================
                              │ signed, least-privilege RPC   │ server-side creds
                              │ (lease sandbox, push tasks)    │ (inference only)
==============================▼===================▼=============================
 ║ DATA PLANE  (untrusted — ephemeral, isolated per project/fork)               ║
 ║  ┌─────────────────────────────────────────────────────────────────────┐   ║
 ║  │ Sandbox = Firecracker microVM: full Linux, shell, Node/Py, git       │   ║
 ║  │  ├ Project filesystem (copy-on-write → forks & checkpoints)          │   ║
 ║  │  ├ Headless browser (Playwright) for self-verification               │   ║
 ║  │  └ Preview server → authenticated reverse proxy (no raw open ports)  │   ║
 ║  │ DEFAULT-DENY EGRESS · metadata endpoint (169.254.169.254) BLOCKED    │   ║
 ║  │ NO ambient platform/cloud/tenant credentials inside the sandbox       │   ║
 ║  └─────────────────────────────────────────────────────────────────────┘   ║
==============================│===============================================
                              │ EXPLICIT deploy action only (own credentials)
==============================▼===============================================
 ║ DEPLOYMENT PLANE  (the user's running app — separate everything)             ║
 ║  Managed hosting you run  |  push-to-Git + provider CI/CD  |  user's cloud    ║
 ║  Its OWN db / auth / storage / secrets — fully separate from the build       ║
==============================│===============================================
                              │ serves
==============================▼===============================================
 ║ USER-APP PLANE  (the shipped app's own end users)                            ║
```

Double lines (`==`) are hard trust boundaries. Crossing upward is only ever done through the narrow labeled channels. The sandbox reaching the model goes **through** the control-plane router, never directly, so credentials and quota stay server-side.

---

### 3. The eight layers

Layers are functional strata; planes are trust strata. A layer can span planes (the verification loop's *logic* lives in orchestration/control, but its *execution* — the browser — lives in the data plane).

| # | Layer | Primary responsibility | Plane(s) | Sibling doc |
|---|---|---|---|---|
| 1 | **Interaction** | Chat, live preview iframe, optional visual editor, task board for legible long runs | Control (UI) + Data (preview) | `06` |
| 2 | **Orchestration / harness** | Planner → task DAG, tool-calling loop, context management (indexing, two-stage retrieval, condensation) | Control | `04` |
| 3 | **Code generation & editing** | Diff/patch or AST-aware edits over full-file rewrites; CodeAct execution | Control (decide) + Data (apply/run) | `04` |
| 4 | **Sandbox / runtime** | Isolated, ephemeral execution of untrusted code | Data | `02` |
| 5 | **Verification loop** | Typecheck/lint → tests → browser smoke test → visual diff; feed failures back | Control (orchestrate) + Data (run) | `05` |
| 6 | **Infrastructure provisioning** | DB schema, auth, storage, RLS, edge functions, seed data | Data (build) → Deployment | `06` |
| 7 | **Deployment boundary** | One explicit deploy action, its own creds, Git sync, env-var management | Deployment | `06` |
| 8 | **Observability & safety** | Every action/observation logged, confirmation gates, policy checks, tenant isolation | Control | `07`, `08` |

**Where the engineering effort actually goes:** Layer 2 (orchestration) and Layer 5 (verification). Layer 5 is the moat (`05-verification-and-evals.md`); Layer 4 is the non-negotiable substrate (`02-sandbox-and-isolation.md`); the model (Layer 3's engine) is important but *swappable by design* (`03-model-layer-and-serving.md`).

---

### 4. Component-by-component responsibilities

#### Control plane

- **API / Auth / Billing / Quota gateway.** Terminates client TLS, authenticates the platform tenant, enforces per-tenant rate limits and credit balances *before* any sandbox is leased or any token is spent. Emits the initiating audit event. Never receives or forwards sandbox-originated requests without re-authentication.
- **Orchestrator (durable workflow engine).** Owns the agent run as a durable workflow: survives process restarts, resumes rather than restarts, makes retries principled and human-approval gates first-class. Holds the planner, the task DAG, and the tool-calling loop. Detailed in `04-orchestration-and-agent-loop.md`. Do **not** hold agent state only in process memory — a crash must not lose an hour of work.
- **Job queue + sandbox scheduler.** Decouples "a run exists" from "a sandbox is executing it." Maintains a **warm sandbox pool** (cold start even at ~125 ms adds up under load), assigns leases, enforces resource caps, and reclaims sandboxes on completion or timeout. See pool/lease/recycle in `02`.
- **Model router (LiteLLM-style).** Presents one OpenAI-compatible surface, routes by task difficulty (small model for trivial edits, coding model for implementation, reasoning model for planning), handles fallbacks and quota, injects inference credentials server-side. This is the *only* path from data plane to models. Full design in `03`.
- **Secrets manager.** Holds platform and tenant secrets. Injects a specific secret into a sandbox *only* when a specific build step genuinely needs it, and into the deployed app at deploy time — never broadcast, never ambient.
- **Audit log + observability.** Append-only trace of every agent action and observation, every tool call, every model call (with cost), every gate decision. This is both your debugging substrate and your abuse-forensics substrate (`07`, `08`).

#### Data plane

- **Sandbox (Firecracker microVM).** Full Linux: shell, Node/Python, package managers, git. One project or one fork per sandbox; destroyed after. Default-deny egress, metadata endpoint blocked, no ambient credentials. Detailed in `02`.
- **Project filesystem (copy-on-write).** The source of truth for a project's code during a build. CoW makes forks and checkpoints cheap (Section 7).
- **Headless browser (Playwright).** Runs *inside* the sandbox to exercise the app and feed failures back — the verification moat (`05`).
- **Preview reverse proxy.** Exposes the preview server on an authenticated, per-project URL. Never raw open ports; an unauthenticated preview is a data leak.

#### Deployment plane

- **Target adapters.** Managed hosting you operate, push-to-Git + provider CI/CD (Vercel/Railway/Fly/Cloudflare), or the user's own cloud via their credentials.
- **Deployed app resources.** Its own DB, auth, storage, secrets — fully separate from the build sandbox, so a compromised build cannot reach production data and vice versa.

---

### 5. Data flow — a full build run

Request → plan → sandbox → verify → deploy. Numbered so `04` and `05` can reference stages precisely.

1. **Request (Control/Interaction).** Tenant sends a prompt. Gateway authenticates, checks quota/credits, opens an audit trace, and creates a **Run** durable workflow.
2. **Plan (Control/Orchestration).** Planner reads project context via two-stage retrieval and emits a **task DAG** (`04`). Destructive/irreversible tasks are flagged for confirmation gates.
3. **Lease sandbox (Control→Data).** Scheduler leases a warm sandbox from the pool, mounts a CoW view of the project filesystem, and hands the task agent a least-privilege RPC channel. No platform credentials cross the boundary.
4. **Implement (Data).** The task agent applies **diff/patch** edits (not full-file rewrites — `04`), runs shell/build steps, and installs dependencies through the egress allowlist (package registries only).
5. **Verify — layered (Data, orchestrated by Control) (`05`).**
   1. Typecheck + lint (always, cheap).
   2. Unit/integration tests.
   3. Playwright browser smoke test of critical flows.
   4. Optional visual diff.
   Cheap checks gate expensive ones. Failures become the next planning observation (reflection loop). Loop 2→5 until gates pass or a retry/budget limit trips.
6. **Checkpoint (Data).** On a green state, snapshot the CoW filesystem as a **Checkpoint** for rollback and forking.
7. **Merge gate (Control, if parallel).** Parallel task agents on CoW forks are merged only after a verification sub-agent passes them (`04`).
8. **Human confirmation gate (Control).** For destructive/irreversible or deploy actions, pause the durable workflow for explicit approval.
9. **Deploy (Deployment).** One explicit action pushes to the chosen target with the app's *own* credentials. Preview stays in the data plane; production lives in the deployment plane.
10. **Observe + bill (Control).** Finalize the audit trace; record cost per successful deploy (the real KPI — `07`).

If the process crashes at any stage, the durable workflow resumes from the last committed step; the CoW checkpoint means no green work is lost.

---

### 6. Technology choices with alternatives

Choose the default unless a listed condition applies. "Swappable by design" is a first-class goal: never lock to one model or one sandbox provider.

| Concern | Default | Strong alternative | Decision rule |
|---|---|---|---|
| Sandbox runtime | Firecracker microVMs | gVisor (fast start on containers), Kata (OCI ergonomics) | microVM for untrusted multi-tenant; gVisor only as a *temporary* move-fast wrapper. Never bare Docker (`02`). |
| Serving engine | vLLM | SGLang | vLLM default: prefix caching + structured outputs. SGLang for its scheduling/RadixAttention. **Not TGI** — maintenance mode since Dec 11, 2025 (`03`). |
| Model router | LiteLLM-style / custom | — | One OpenAI-compatible surface, task-difficulty routing, quota, fallbacks (`03`). |
| Orchestration | Durable workflow engine (Temporal-style) | Custom event-sourced runner | Runs are minutes–hours and must survive restarts (`04`). |
| Agent harness base | OpenHands (CodeAct) | LangGraph, custom ReAct | OpenHands is the fastest on-ramp; keep tools/loop swappable (`04`, `09`). |
| Code editing | Diff/patch + AST-aware | Full-file rewrite | Full-file rewrites are the #1 silent-regression source — avoid (`04`). |
| Browser verification | Playwright | Puppeteer | Playwright default; runs inside the sandbox (`05`). |
| Generated backend | One opinionated stack (React/Tailwind + managed Postgres/auth/storage) | Second stack later | Opinionation drives reliability; support **one** stack deeply first (`06`, `09`). |
| Preview exposure | Authenticated reverse proxy, per-project | — | Never raw open ports (`02`, `06`). |
| Deploy target | Managed hosting you run | Git+CI/CD; user's cloud | In order of increasing user control (`06`). |

---

### 7. Minimum viable data model

The control plane owns this. Copy-on-write is the mechanism that makes checkpoints and parallel forks affordable.

```
User
 └── Project (belongs to a Tenant; namespace-isolated)
      ├── Files ── (CoW snapshots) ──▶ Checkpoint*   (rollback / fork points)
      ├── Run / Job*                                  (durable workflow instances)
      │     └── Task*  (nodes of the task DAG; may run on CoW forks)
      ├── SandboxLease*                               (which microVM, TTL, caps)
      ├── Database                                    (the build-time project DB)
      ├── Secret*                                     (control-plane managed; never ambient)
      ├── Deployment*                                 (target, own creds, status)
      ├── GitRemote                                   (export / sync)
      └── Connector*                                  (MCP-style external tools)
```

#### Core entities

| Entity | Key fields | Notes |
|---|---|---|
| **User / Tenant** | id, auth identity, plan, credit balance | Tenant is the isolation unit; namespace + network policy per tenant (`08`). |
| **Project** | id, tenant_id, stack, created_at | One opinionated stack per project (`06`). |
| **Checkpoint** | id, project_id, parent_id, cow_ref, created_at | CoW snapshot; parent_id forms the fork/undo tree. |
| **Run / Job** | id, project_id, workflow_id, status, cost | Durable workflow instance; resumable (`04`). |
| **Task** | id, run_id, dag_parents[], fork_ref, status | DAG node; parallel tasks fork from a checkpoint. |
| **SandboxLease** | id, run_id, microvm_id, caps, ttl, egress_policy | Ephemeral; recycled on completion/timeout (`02`). |
| **Secret** | id, scope (tenant/project/deploy), ref | Value in secrets manager, never in the row; injected just-in-time. |
| **Deployment** | id, project_id, target, own_credentials_ref, status | Separate creds from build; deployment plane. |

#### Invariants (enforce in schema + code)

- A `SandboxLease` never references a platform/cloud/tenant credential.
- A `Secret` value is never persisted in a project row or checkpoint; only a reference.
- A `Checkpoint` is immutable once written; rollback/fork creates new checkpoints.
- Every `Run`, `Task`, and gate decision emits an append-only audit event.
- Cross-tenant foreign keys are impossible by construction (tenant_id required and enforced at the query layer).

---

### 8. Design review checklist

- [ ] Does any generated code path touch the control plane? (Must be **no**.)
- [ ] Does the sandbox reach models only through the control-plane router? (Must be **yes**.)
- [ ] Default-deny egress + metadata endpoint block enforced from day one? (`02`)
- [ ] No ambient credentials in the sandbox; secrets injected just-in-time? (`03`, `06`)
- [ ] Editing uses diff/patch, not full-file rewrites? (`04`)
- [ ] Verification runs cheap→expensive and feeds failures back? (`05`)
- [ ] Deployment plane has its own DB/auth/storage/secrets, separate from build? (`06`)
- [ ] Every action/observation lands in the append-only audit log? (`07`, `08`)
- [ ] Model layer is swappable; no hard-coded single model? (`03`)
- [ ] One opinionated stack supported deeply before adding a second? (`06`, `09`)

Get these ten right and the rest of The Blueprint is filling in detail on a sound skeleton.
