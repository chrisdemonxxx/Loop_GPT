# Loop-it — End-to-End Build Plan (Phases 0–5, Production-Ready Multi-Tenant SaaS)

Derived from `combined.md` (the Handbook). This plan turns the handbook's architecture into a
staffable, fundable, buildable program: concrete stack picks, a monorepo layout, phase-by-phase
tickets, exit gates, CI/CD, and launch checklists.

**Scope chosen:** full multi-tenant SaaS, Phases 0–5 as written in Handbook Doc 09.

---

## 0. Invariants (never negotiable, apply from commit #1)

| #   | Invariant                                                                                                            | Enforced by                                                             |
| --- | -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| I1  | Agent-generated code executes **only** in the data plane. Never in the control plane.                                | Architecture review question on every PR: _"where does this code run?"_ |
| I2  | No ambient credentials in any sandbox.                                                                               | Sandbox image build test + red-team check                               |
| I3  | Default-deny egress; category allowlist through a logging proxy.                                                     | Egress proxy config, CI policy test                                     |
| I4  | Metadata endpoint (`169.254.169.254` + provider equivalents) blocked, fail-closed.                                   | Standing red-team test in CI                                            |
| I5  | Model router is the **only** sandbox→model path. Keys injected server-side.                                          | Network policy + router audit                                           |
| I6  | Edits are diff/patch or AST-aware. No full-file rewrites of existing files.                                          | `apply_patch` is the only write tool                                    |
| I7  | Confirmation gate on every destructive/irreversible action (deploy, delete, spend, external write, secret rotation). | Durable-workflow gate primitive                                         |
| I8  | Previews served only via authenticated per-project reverse proxy. No raw sandbox ports.                              | Proxy is the only ingress; port-scan test                               |
| I9  | RLS on by default in every generated schema.                                                                         | Provisioning tool emits it; T2 eval verifies                            |
| I10 | Every action/observation/approval lands in an append-only audit log.                                                 | Audit middleware, immutability test                                     |
| I11 | Model-content policy and infrastructure-abuse policy are **separate** documents and separate enforcement paths.      | Governance docs + policy engine split                                   |
| I12 | Every agent loop is bounded (iterations, tokens, wall-clock, credits).                                               | Budget object on every Run                                              |

**Definition of Done for any feature:** invariants hold, audit events emitted, eval-harness regression
green, red-team suite green, runbook entry written, cost impact modelled.

---

## 1. Technology decisions (locked; alternatives noted)

| Concern                                         | Decision                                                                                                                                                                                 | Rationale / revisit trigger                                        |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Monorepo tooling                                | pnpm workspaces + Turborepo (TS) and uv workspaces (Python)                                                                                                                              | Two languages, one repo. Revisit if Python share <10%.             |
| Control-plane API                               | TypeScript, Fastify + tRPC (internal) + OpenAPI (public)                                                                                                                                 | Type-sharing with web UI                                           |
| Orchestrator                                    | **Temporal** (self-hosted → Temporal Cloud)                                                                                                                                              | Handbook Doc 04 §1: durability, signals, timers. Do not hand-roll. |
| Orchestrator workers                            | Python (best LLM/agent ecosystem), Temporal Python SDK                                                                                                                                   | Agent harness is Python                                            |
| Agent harness base                              | Fork/adopt **OpenHands** (CodeAct) in Phase 0–1; replace loop with own Temporal-driven loop by Phase 3                                                                                   | Doc 09 Phase 0 build-vs-buy                                        |
| Model serving                                   | **vLLM** (OpenAI-compatible). SGLang as alternate backend. **Never TGI** (maintenance mode since 2025-12-11)                                                                             | Doc 03 §1                                                          |
| Model router                                    | **LiteLLM** proxy, wrapped by our own `router-svc` for quota/audit/cost                                                                                                                  | Doc 03 §2; keeps models swappable                                  |
| Sandbox runtime                                 | Phase 0–3: managed Firecracker provider (E2B-class). Phase 4: evaluate self-hosted Firecracker                                                                                           | Doc 09 Phase 1 & 4 decisions                                       |
| Sandbox FS / CoW                                | ZFS or overlay-on-btrfs snapshots backing an object-store-persisted checkpoint tree                                                                                                      | Doc 02 §4                                                          |
| Egress control                                  | Squid/Envoy forward proxy, domain allowlist, full request logging; netfilter default-deny + link-local drop                                                                              | Doc 02 §5                                                          |
| Control-plane DB                                | Postgres 16 (projects, runs, checkpoints, billing, audit partitions)                                                                                                                     | —                                                                  |
| Queue / events                                  | Temporal for workflows; NATS or Redis Streams for fan-out telemetry                                                                                                                      | —                                                                  |
| Generated-app stack (the ONE opinionated stack) | **React + Vite + TypeScript + Tailwind + shadcn/ui** frontend; **Postgres + PostgREST-style API + GoTrue auth + S3-compatible storage** backend (Supabase-compatible shape, self-hosted) | Doc 09 Phase 2. Second stack only after Phase 5.                   |
| Generated-app hosting                           | Managed hosting we operate (containers on Fly/K8s) → Git+provider CI/CD → user's cloud                                                                                                   | Doc 06 §5                                                          |
| Browser verification                            | **Playwright**, inside the sandbox, hitting the preview proxy                                                                                                                            | Doc 05                                                             |
| Secrets                                         | HashiCorp Vault (transit + KV v2), scoped short-lived leases                                                                                                                             | Doc 06 §4                                                          |
| Observability                                   | OpenTelemetry → Grafana stack (Tempo/Loki/Mimir); audit to append-only Postgres partition + object-store WORM mirror                                                                     | Doc 07                                                             |
| SAST on generated apps                          | Semgrep + gitleaks + npm/pip audit, run in-sandbox as verification layer L2.5                                                                                                            | Doc 08 §4                                                          |
| Auth (platform)                                 | Ory Kratos/Hydra or Auth0; org/team RBAC in our own model                                                                                                                                | —                                                                  |
| Billing                                         | Stripe + internal credit ledger (source of truth is our ledger, not Stripe)                                                                                                              | Doc 06 §1                                                          |
| IaC                                             | Terraform + Helm; environments `dev`/`staging`/`prod`                                                                                                                                    | Doc 07 §7                                                          |
| CI/CD                                           | GitHub Actions; progressive delivery via Argo Rollouts (canary)                                                                                                                          | Doc 07 §7                                                          |

---

## 2. Monorepo layout

```
loop-it/
├─ docs/                          # combined.md split back into 00–10 + ADRs
│  └─ adr/                        # one ADR per locked decision in §1
├─ apps/
│  ├─ web/                        # React UI: chat, task board, preview iframe, checkpoints
│  ├─ api/                        # TS control-plane gateway (authN/Z, rate limit, REST/WS)
│  └─ admin/                      # internal ops console: abuse queue, quotas, kill switches
├─ services/
│  ├─ orchestrator/               # Python Temporal workers: Run workflow, planner, task agents
│  ├─ router-svc/                 # model router wrapper: routing policy, quota, cost, audit
│  ├─ scheduler/                  # sandbox pool, leases, resource caps, recycle
│  ├─ preview-proxy/              # authenticated per-project reverse proxy
│  ├─ egress-proxy/               # allowlisting + logging forward proxy for sandboxes
│  ├─ secrets-broker/             # Scoped/JIT secret leasing library used in-process by trusted services
│  ├─ billing/                    # credit ledger, metering, Stripe sync
│  └─ abuse-engine/               # signal ingestion, T0–T3 automated response
├─ packages/
│  ├─ agent-core/                 # (py) tool schemas, ReAct/CodeAct loop, context mgmt
│  ├─ tools/                      # (py) read_file, search_code, apply_patch, run_shell, browser, provision, deploy
│  ├─ patch/                      # (py) diff validation + AST-aware transforms
│  ├─ sandbox-sdk/                # (py+ts) signed least-privilege RPC client/server
│  ├─ contracts/                  # OpenAPI + JSON Schemas (task DAG, tool calls, audit events)
│  ├─ policy/                     # OPA/Rego: destructiveness, egress categories, quota
│  └─ ui-kit/                     # shared React components
├─ sandbox/
│  ├─ image/                      # base rootfs: Node, Python, pnpm, uv, git, Playwright browsers
│  ├─ agent-runtime/              # in-VM supervisor exposing the RPC tool surface
│  └─ network/                    # nftables rules, metadata block, egress proxy pinning
├─ stack-templates/
│  └─ react-postgres/             # THE opinionated stack: scaffolds, migrations, RLS generators, seed
├─ evals/
│  ├─ harness/                    # runner, scoring, KPI computation
│  ├─ tiers/                      # T0 landing page → T1 CRUD → T2 multi-user+RLS → T3 SaaS+payments
│  └─ redteam/                    # escape, metadata, cross-tenant, injection, abuse suites
├─ infra/
│  ├─ terraform/                  # accounts, VPCs, K8s, Firecracker hosts, Vault, Temporal
│  ├─ helm/                       # per-service charts
│  └─ runbooks/                   # Doc 07 runbooks as executable checklists
└─ .github/workflows/             # CI: lint, test, contracts, evals, redteam, canary deploy
```

---

## 3. Phase 0 — Foundations (≈1–2 weeks, 1–2 engineers)

**Goal:** prove the loop exists. Build a trivial app end-to-end, no human code edits.

| ID    | Ticket                                                                                                   | Status | Notes                                           |
| ----- | -------------------------------------------------------------------------------------------------------- | ------ | ----------------------------------------------- |
| P0-1  | Bootstrap monorepo, CI (lint/typecheck/test), ADR process, split `combined.md` into `docs/00–10`         | done   | Docs are the spec; keep them in-repo            |
| P0-2  | Stand up one scale-to-zero managed inference endpoint; OpenAI-compatible                                 | infra  | Doc 09 P0: buy, do not own GPUs                 |
| P0-3  | `router-svc` v0: single upstream, server-side key injection, per-request cost logging                    | done   | Establishes I5 on day one                       |
| P0-4  | Integrate managed microVM sandbox provider; `sandbox-sdk` v0 with signed RPC                             | part   | SDK + signed channel done; provider is infra    |
| P0-5  | `agent-core` v0: ReAct loop with `read_file`, `apply_patch`, `run_shell`                                 | done   | `apply_patch` only — enforces I6 from the start |
| P0-6  | `packages/patch` v0: unified-diff validation, hunk-context matching, stale-read rejection                | done   | Doc 04 §6                                       |
| P0-7  | Structured outputs for tool calls (JSON-schema constrained decoding)                                     | part   | Schema + router passthrough done; needs P0-2    |
| P0-8  | Egress default-deny + metadata block on the provider sandbox; assert `curl 169.254.169.254` fails closed | done   | I3/I4 from day one                              |
| P0-9  | Audit event schema + append-only writer                                                                  | done   | I10                                             |
| P0-10 | Eval seed: T0 task "build a todo app"; record iterations, tokens, success                                | done   | Seeds the harness early                         |

`infra` = blocked on a provisioned account (inference endpoint / microVM provider), not on code.

**Exit gate:** the loop creates, runs, and fixes a trivial app end-to-end with **zero human code edits**.
**Weekly metrics:** loop-closes (y/n), iterations-to-success, tokens/task, days-to-first-working-build.
**Budget:** inference $200–1.5k/mo; sandbox ~$0–100/mo; 1–2 salaries.

---

## 4. Phase 1 — Core loop + real sandbox (≈2–4 weeks, 2–3 engineers)

**Goal:** production-shaped isolation; the loop self-corrects via the browser.

| ID    | Ticket                                                                                                                   | Status |
| ----- | ------------------------------------------------------------------------------------------------------------------------ | ------ |
| P1-1  | `scheduler` v1: warm pool, lease with TTL + CPU/mem/disk/wallclock caps, recycle-on-done (never reuse across tenants)    | done   |
| P1-2  | `egress-proxy`: category allowlist (registries, router, chosen APIs, deploy), full request logging, mining-pool denylist | done   |
| P1-3  | Sandbox base image: Node, Python, package caches, Playwright browsers pre-installed (kills cold `npm install`)           | done   |
| P1-4  | CoW project filesystem + immutable Checkpoint tree (`parent_id`), persisted off-VM                                       | done   |
| P1-5  | `browser` tool: in-sandbox Playwright, navigates preview, captures console/network errors                                | done   |
| P1-6  | `preview-proxy` v1: authenticated per-project routing; no public sandbox ports                                           | done   |
| P1-7  | Verification L0/L1: typecheck+lint → unit/integration tests; cheap gates expensive                                       | done   |
| P1-8  | Reflection loop: failed verification becomes the next planning observation                                               | done   |
| P1-9  | Context mgmt: two-stage retrieval (coarse locate → focused read); stable prefix first for cache hits                     | done   |
| P1-10 | Context condensation on token-budget threshold; full history retained for audit                                          | done   |
| P1-11 | Budget object on every Run (iterations/tokens/time) — I12                                                                | done   |
| P1-12 | Red-team suite v1 in CI: escape attempt, metadata reach, egress bypass                                                   | done   |

**Exit gate:** a CRUD app builds **and the agent self-corrects ≥1 introduced bug via the browser test**,
running on real microVM isolation with egress + metadata controls enforced.
**Metrics:** self-correction rate, CRUD success rate, sandbox cold-start p50/p95, iterations/build.
**Budget:** inference $1–5k; sandbox $0.5–3k; 2–3 salaries.

---

## 5. Phase 2 — Opinionated full-stack generation (≈3–6 weeks, 3–5 engineers)

**Goal:** one stack, supported deeply. Highest-ROI reliability work in the program.

| ID    | Ticket                                                                                                       | Status |
| ----- | ------------------------------------------------------------------------------------------------------------ | ------ |
| P2-1  | Freeze `stack-templates/react-postgres` — scaffold, conventions, lint/test config, CI template               | done   |
| P2-2  | `provision` tool: create schema, tables, migrations, auth, storage buckets, seed data, edge functions        | done   |
| P2-3  | **RLS generator**: every table gets RLS enabled + default-deny + owner/tenant policies, automatically (I9)   | done   |
| P2-4  | Managed backend for generated apps: per-project Postgres (schema- or DB-isolated), GoTrue auth, S3 storage   | done   |
| P2-5  | Git sync: per-project remote, scoped short-lived creds, checkpoint-aligned commits, full export (no lock-in) | done   |
| P2-6  | Planner task vocabulary narrowed to the stack ("add table + RLS", "add route", "wire auth")                  | done   |
| P2-7  | Verification L2: browser smoke of critical flows (signup → login → create → read-back)                       | done   |
| P2-8  | Verification L2.5: SAST pass — Semgrep, gitleaks, dependency audit on generated code                         | done   |
| P2-9  | Eval tiers T0/T1 formalised with scoring; per-tier success + cost dashboards                                 | done   |
| P2-10 | Secrets discipline v1: in-process `secrets-broker` JIT per-step injection; build↔prod firewall                | done   |

**Exit gate:** "build a multi-user app with login and persistent data" works with **real data flows, not
mocks**, and **RLS is on by default** in 100% of generated schemas.
**Metrics:** T0/T1 success rate, % schemas with RLS (must reach 100%), real-data-flow success, cost/build.
**Budget:** inference $3–12k; sandbox $2–8k; managed backend $0.5–3k; 3–5 salaries.

Status note: code and automated tests are present; first live production data-flow proof still requires
operator-provisioned Postgres/auth/storage, sandbox, and model credentials.

---

## 6. Phase 3 — Orchestration + parallelism (≈4–6 weeks, 4–6 engineers)

**Goal:** durable planner/DAG, parallel agents on CoW forks, gated merges.

| ID    | Ticket                                                                                                                                                                             | Status |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| P3-1  | Temporal deployment (HA); `Run` modelled as a durable workflow; sandbox calls are activities with timeouts                                                                         | done   |
| P3-2  | Migrate agent loop off OpenHands' loop onto our Temporal-driven loop (tools/harness retained)                                                                                      | done   |
| P3-3  | Planner → **task DAG** via structured outputs, validated against the DAG schema; nodes carry goal, `dag_parents`, fork checkpoint, expected verification, **destructiveness flag** | done   |
| P3-4  | Parallel task agents: one sandbox per CoW fork of the same green checkpoint                                                                                                        | done   |
| P3-5  | **Merge gate**: verification sub-agent (L0→L2) must pass; conflicting writes detected; losing fork re-runs on winner's checkpoint (serialize, never blind 3-way merge)             | done   |
| P3-6  | Confirmation gates: durable pause on approval signal (no held process/lease); auto-approve only reversible actions (I7)                                                            | done   |
| P3-7  | `packages/policy`: OPA rules classifying action reversibility + destructiveness                                                                                                    | done   |
| P3-8  | Security-analyzer pass on **proposed** actions before execution                                                                                                                    | done   |
| P3-9  | Failure taxonomy implemented: transient / verification / budget / merge-conflict / gate-rejected / hard-error                                                                      | done   |
| P3-10 | Re-planning: revise the remaining DAG on invalidated assumptions, never restart                                                                                                    | done   |
| P3-11 | Task board UI: legible long autonomous runs, per-node status, gate prompts                                                                                                         | done   |
| P3-12 | End-to-end cost attribution → first real `cost_per_successful_deploy`                                                                                                              | done   |

**Exit gate:** **two independent features build in parallel and merge without clobbering each other.**
**Metrics:** parallel-merge success rate, conflict rate, sub-agent catch rate, wall-clock multi-feature, cost/successful-deploy.
**Budget:** inference $8–30k; sandbox $5–20k; 4–6 salaries.

Status note: workflows/UI/cost plumbing are implemented. HA Temporal and parallel-merge behavior have not
been proven against live production infrastructure in this environment.

---

## 7. Phase 4 — Production hardening (ongoing; 6–10 people, incl. dedicated security + SRE)

**Goal:** a platform you can safely point the public at. **This is the launch phase.**

### 7.1 Multi-tenancy & platform

| ID   | Ticket                                                                                                     | Status |
| ---- | ---------------------------------------------------------------------------------------------------------- | ------ |
| P4-1 | Platform auth: orgs, teams, RBAC, SSO-ready; gateway issues signed identity, downstream trusts only that   | done   |
| P4-2 | Namespace isolation + K8s/network policies per tenant; per-tenant credentials; zero shared sandboxes       | done   |
| P4-3 | Rate limits + hard/soft quotas enforced **before** a sandbox lease or a token is spent                     | done   |
| P4-4 | `billing`: credit ledger (our source of truth), metering from router + scheduler, Stripe sync, plan limits | done   |
| P4-5 | User-facing checkpoints: rollback + fork in the UI (CoW ref swap, instant, reversible)                     | done   |

### 7.2 Security & abuse

| ID    | Ticket                                                                                                                                                                                          | Status |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| P4-6  | `abuse-engine`: taxonomy signals → automated T0–T3 response (warn, throttle, kill sandbox, suspend tenant)                                                                                      | done   |
| P4-7  | Miner/scan detection: max-CPU-without-build-progress heuristic, pool denylist at proxy, fan-out kill, unexpected-GPU kill                                                                       | done   |
| P4-8  | Full red-team suite as a **release blocker**: sandbox escape, metadata reach, cross-tenant read, preview-URL auth bypass, prompt-injection→exfil, injection→deploy, secret exfil, egress bypass | done   |
| P4-9  | Secrets hygiene audit: no secrets in logs/traces/checkpoints/generated client code; automated scanning                                                                                          | done   |
| P4-10 | Audit log: append-only, immutable, WORM mirror, retention policy, forensics queries                                                                                                             | done   |
| P4-11 | Disclosure + incident-response process; security.txt; severity matrix; on-call rotation                                                                                                         | done   |

### 7.3 Observability & ops

| ID    | Ticket                                                                                 | Status |
| ----- | -------------------------------------------------------------------------------------- | ------ |
| P4-12 | OTel traces for every agent step; golden signals dashboards; per-run replayable trace  | done   |
| P4-13 | Cost dashboards with **cost-per-successful-deploy** as the north-star metric           | done   |
| P4-14 | Warm-pool autoscaling + scale-to-near-zero when idle; forgotten-endpoint weekly check  | done   |
| P4-15 | Backup/restore + checkpoint recovery drills (tested, not documented-only)              | part   |
| P4-16 | Canary rollout + one-click rollback (Argo Rollouts); runbooks in `infra/runbooks/`     | done   |
| P4-17 | Eval harness gates **every** deploy: T0–T3 regression + red-team must be green to ship | done   |

### 7.4 Build-vs-buy decisions to make here

- **Own GPUs + self-hosted vLLM?** Only when §9 break-even is clearly crossed **and** duty cycle is high.
- **Self-hosted Firecracker?** Flip from the provider when density/margin justify host engineering.

**Exit gate (release blocker):** red-team **fails** to escape the sandbox, reach the metadata endpoint, or
touch another tenant; eval harness gates deploys; billing and quotas live.
**Metrics:** the four KPIs per tier (success rate, iterations, cost/successful-deploy, human-intervention
rate) + red-team status, p95 latency, GPU duty cycle, abuse rate & MTTC.
**Budget:** inference $20–80k+; sandbox $15–60k; observability $2–10k; 6–10 salaries.

Status note: production hardening surfaces are implemented and documented. Backup/restore has scripts and a
checklist, but a live production recovery drill is still operator work after provisioning.

---

## 8. Phase 5 — Openness + differentiation (ongoing; 8+ people)

| ID   | Ticket                                                                                                                                  | Status |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| P5-1 | User-selectable open models via the router; per-model routing policy by task difficulty                                                 | done   |
| P5-2 | **Per-model license register**: base model + derivative, field-of-use terms, re-verified before commercial serving (Doc 10 §3)          | done   |
| P5-3 | Low-refusal/abliterated model protocol: benchmark **modified vs base** on our eval harness; ship only if no coding/reasoning regression | done   |
| P5-4 | Optional fine-tuning on high-quality build-and-deploy traces we own (with consent + data-handling policy)                               | done   |
| P5-5 | Connectors (MCP-style), per-project scoped, egress-allowlisted, least-privilege                                                         | done   |
| P5-6 | Agent templates / starter recipes on the opinionated stack                                                                              | done   |
| P5-7 | Enterprise: SSO, audit export, VPC / self-host distribution, DPA                                                                        | done   |
| P5-8 | Second stack — **only** after the first is at target success rate                                                                       | not started |

**Exit gate (standing):** model choice swappable via router with 100% per-model licensing tracked, and the
model-content vs infrastructure-abuse policy separation enforced in production.
**Budget:** inference $40–150k+; sandbox $30k+; 8+ salaries; one-off fine-tune compute.

Status note: open-model, license, connector, enterprise, and starter-recipe code paths exist. The second
stack remains intentionally not started until live reliability justifies it.

---

## 9. Cost model (instrument these from Phase 1)

```
inference_$      = requests × avg_iterations × tokens_per_iteration × price_per_token
                   × (1 − prefix_cache_hit_fraction)      # applied to prompt tokens
owned_$          = num_gpus × gpu_hourly × 730 / duty_cycle_utilization
sandbox_$        = (builds × avg_build_minutes / 60) × cost_per_sandbox_hour
                   + warm_pool_size × pool_cost_per_hour × 730
NORTH STAR:
cost_per_successful_deploy = (inference_$ + sandbox_$ + backend_$) / successful_deploys
```

Own GPUs when `managed_$(steady volume) > owned_$` **and** duty cycle is high. Optimize
cost-per-successful-deploy, never cost-per-token — a cheap model needing 9 iterations loses to an
expensive one needing 2.

---

## 10. Governance & legal track (runs parallel from Phase 2; blocks revenue)

| ID  | Ticket                                                                                                           | Blocks     | Status |
| --- | ---------------------------------------------------------------------------------------------------------------- | ---------- | ------ |
| G-1 | Two-policy split: **model-content policy** vs **infrastructure-abuse policy**, separately owned and enforced     | Launch     | done   |
| G-2 | Acceptable-Use Policy published; abuse-report intake; enforcement ladder                                         | Launch     | done   |
| G-3 | Payment-processor + hosting-provider AUP review — confirm our model stance is compatible **before** taking money | First $    | operator/legal review required |
| G-4 | Data-handling policy: what we log, retention, trace/fine-tune consent, deletion, DPA                             | Enterprise | draft; legal review required |
| G-5 | Per-model license register + pre-commercial re-verification                                                      | Phase 5    | done   |
| G-6 | Law-enforcement request handling process                                                                         | Launch     | documented |
| G-7 | Code-ownership & export guarantee documented and tested (full Git export works)                                  | Launch     | documented; live export test required |
| G-8 | Jurisdiction review for hosting + incorporation                                                                  | First $    | operator/legal review required |
| G-9 | Governance RACI + quarterly review cadence (licenses, OWASP list edition, provider ToS, GPU pricing)             | Ongoing    | documented |

---

## 11. Cross-cutting engineering standards

- **CI on every PR:** lint, typecheck, unit, contract tests against `packages/contracts`, policy tests, `evals/redteam` fast subset.
- **CI nightly:** full eval harness T0–T3, full red-team, cost regression report.
- **Deploy gate:** no ship if eval regression or any red-team failure. No exceptions, no "temporarily".
- **ADR required** for any change to a §1 decision or a §0 invariant.
- **Every service** emits OTel traces + audit events; no service logs raw secrets.
- **Chaos/DR drills** quarterly from Phase 4: kill a worker mid-run (must resume), restore from checkpoint, revoke a leaked credential.

---

## 12. Risk register (owners assigned at Phase 0 kickoff)

| #   | Risk                                                          | Phase | Mitigation                                                            |
| --- | ------------------------------------------------------------- | ----- | --------------------------------------------------------------------- |
| R1  | Sandbox escape / metadata exposure → control-plane compromise | 1→    | microVM, default-deny egress, metadata block, red-team gate           |
| R2  | Cross-tenant leak                                             | 4→    | Per-tenant isolation, no shared creds, authenticated preview proxy    |
| R3  | Infrastructure abuse at launch                                | 4→    | Egress allowlist + abuse taxonomy + automated T0–T3                   |
| R4  | Prompt injection / excessive agency                           | 3→    | Least-privilege tools, confirmation gates, untrusted-content handling |
| R5  | Abliterated model regresses on coding                         | 5     | Benchmark modified vs base before shipping                            |
| R6  | Model-license non-compliance                                  | 5     | License register + pre-commercial verification                        |
| R7  | Runaway GPU spend / forgotten endpoint                        | 1→    | Scale-to-zero, quota alarms, weekly check                             |
| R8  | Low reliability from an over-general stack                    | 2→    | One opinionated stack, deeply supported                               |
| R9  | Full-file rewrites cause silent regressions                   | 1→    | `apply_patch` is the only write tool                                  |
| R10 | Lost work from crashed long runs                              | 3→    | Temporal + CoW checkpoints                                            |
| R11 | Processor / hosting ToS suspension                            | 4→    | G-3 before taking money                                               |
| R12 | Verification too shallow → ships broken apps                  | 2→    | Layered L0–L2.5 incl. real browser smoke                              |

---

## 13. Phase gate summary

| Phase | Exit gate (must be demonstrable)                                                                                  |
| ----- | ----------------------------------------------------------------------------------------------------------------- |
| 0     | Loop creates + runs + fixes a trivial app with no human code edits                                                |
| 1     | CRUD app builds; agent self-corrects ≥1 bug via browser test; real microVM isolation + egress + metadata controls |
| 2     | Multi-user app with login + persistent real data; RLS on by default (100%)                                        |
| 3     | Two features build in parallel and merge without clobbering                                                       |
| 4     | Red-team fails to escape sandbox / reach metadata / touch another tenant; evals gate deploys; billing live        |
| 5     | Open-model choice via router, 100% licensing tracked; content-vs-abuse policy separation enforced                 |

**Never advance a phase on schedule alone. The gate is the truth.**

---

## 14. Immediate next actions (week 1)

1. Split `combined.md` into `docs/00-blueprint.md` … `docs/10-governance-legal-policy.md`.
2. Scaffold the monorepo per §2; wire CI (lint/typecheck/test) and the ADR template.
3. Write ADRs for the §1 locked decisions (one per row) so they're reviewable, not assumed.
4. Provision: one scale-to-zero inference endpoint, one managed microVM sandbox account, a Vault dev instance.
5. Ship P0-3 (`router-svc` v0), P0-4 (`sandbox-sdk` v0), P0-8 (egress + metadata block) **together** — the
   invariants go in before the first agent loop, not after.
6. Land P0-5/P0-6 (loop + `apply_patch`) and run the T0 "todo app" eval to open the Phase 0 gate.
