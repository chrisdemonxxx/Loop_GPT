# 09 — Execution Roadmap

**Purpose:** This is the phased build plan for shipping an open, model-unrestricted AI app-builder — Phases 0 through 5, each with explicit entry/exit gates, team and skill requirements, budget envelopes with cost-model formulas, the two or three build-vs-buy decisions that actually matter in that phase, a risk register, and the weekly metrics that tell you whether the phase is working. It sharpens the roadmap in `00-blueprint.md` into something you can staff and fund. Timelines assume a small, senior team and are directional — **gates, not calendars, decide phase transitions.** Throughout, the hard boundary from `00-blueprint.md` holds: "unrestricted" is open model choice + code ownership + capability breadth, layered on hardened isolation (`02-sandbox-and-isolation.md`) — and agent-generated code executes only in the data plane, never the control plane.

---

### 1. How to read this doc

- **Entry gate:** what must be true to start the phase. **Exit gate:** what must be demonstrably true to leave it (and to unlock spend for the next).
- **Budget envelope:** monthly run-rate ranges in three buckets — **GPU/inference**, **sandbox infra**, **team**. Ranges are directional; plug your real rates into the formulas in §8.
- **Build-vs-buy:** the decisions that dominate cost and risk that phase. Default early = buy managed; default late = own for margin.
- Cross-references: sandbox (`02`), model serving (`03`), orchestration (`04`), verification/evals (`05`), control plane/deploy (`06`), ops (`07`), security/abuse (`08`), governance (`10`).

**Golden rule of the roadmap (from `00`):** commit to one opinionated stack (Phase 2) and build the internal eval harness (Phase 4 formalizes it, Phase 1 seeds it) before you scale spend. You cannot improve what you don't measure, and the metric that matters is **cost per successful deploy**, not cost per token.

---

### 2. Phase 0 — Foundations

**Goal:** prove the agent loop exists at all. A minimal ReAct/CodeAct loop against one open model endpoint, with file-edit + bash tools, building a trivial app in an isolated, disposable sandbox. OpenHands is the fastest on-ramp. Even at this phase the isolation baseline applies: use a managed microVM/gVisor-class sandbox (usage-based providers make this near-free at prototype volume) or strictly local, single-developer execution with no tenant exposure — never a bare shared-kernel container path that later "hardens into" the platform.

- **Entry gate:** decision to build; one open-model endpoint reachable (managed is fine).
- **Exit gate:** the loop can create, run, and fix a trivial app ("build a todo app") end-to-end **without you touching the code**.
- **Duration:** ~1–2 weeks.

**Team & skills:** 1–2 senior engineers (Python/TS, LLM tool-calling, basic Linux). No dedicated security/infra hire yet.

**Budget envelope (monthly):** GPU/inference $200–$1,500 (a single scale-to-zero managed endpoint); sandbox infra ~$0–$100 (usage-based managed microVM sandbox provider free/low tier); team = 1–2 salaries. **Do this:** use a managed endpoint and scale-to-zero — do not buy GPUs yet.

**Build-vs-buy:**
| Decision | Recommendation |
|---|---|
| Agent harness | **Buy/adopt open source** (OpenHands) — do not write your own loop yet. |
| Model serving | **Buy** managed endpoint (Hugging Face Inference Endpoints or equivalent), scale-to-zero. |
| Sandbox | **Buy** — a managed microVM-based sandbox provider (usage-based) from day one, or keep execution strictly local single-developer. Bare shared-kernel containers are not a phase, they are a dead end. |

**Weekly metrics:** does the loop close on a trivial task (yes/no)? iterations to success; tokens/task; days-to-first-working-build.

---

### 3. Phase 1 — Core loop + real sandbox

**Goal:** move from the prototype sandbox to your own production-shaped isolation and make the loop self-correct. Integrate a microVM-based sandbox; implement plan → code → execute → observe → iterate; add two-stage codebase retrieval and context condensation for longer sessions; add basic Playwright smoke testing.

- **Entry gate:** Phase 0 exit met.
- **Exit gate:** a CRUD app builds **and the agent self-corrects at least one introduced bug via the browser test**.
- **Duration:** ~2–4 weeks.

**Team & skills:** 2–3 engineers; add infra/Linux depth (microVM or sandbox-provider integration). Playwright/browser-automation familiarity.

**Budget envelope (monthly):** GPU/inference $1,000–$5,000 (more eval + iteration traffic); sandbox infra $500–$3,000 (managed Firecracker-based provider, usage-based); team = 2–3 salaries.

**Build-vs-buy — the key Phase 1 decision:**
| Decision | Buy (managed Firecracker provider, e.g. E2B-class) | Build (self-hosted Firecracker) |
|---|---|---|
| Speed | Days to integrate | Weeks of KVM/host engineering |
| Control | Provider's egress/limits | Full control over egress + metadata block |
| Cost at scale | Per-use premium | Cheaper per sandbox once dense |
| **Recommendation** | **Buy now.** Firecracker figures you're relying on (<125 ms boot, <5 MiB overhead, 150 microVMs/s per host — verified Aug 17, 2026) are the *provider's* to deliver at this stage. | Defer to Phase 4 when density/margin justify it. |

**Do this:** even on a managed provider, enforce default-deny egress and the metadata-endpoint block from `02`/`08` on day one. **Don't do this:** ship containers on a shared kernel because "it's just a demo" — Phase 1 is where isolation discipline becomes muscle memory.

**Weekly metrics:** self-correction rate (bugs fixed via browser feedback ÷ bugs introduced); CRUD-task success rate; sandbox cold-start p50/p95; iterations per successful build.

---

### 4. Phase 2 — Opinionated full-stack generation

**Goal:** pick **one** stack and support it deeply (e.g., React/Tailwind frontend + managed Postgres/auth/storage backend). Give the agent provisioning tools: schema, auth, **RLS**, storage, seed data, edge functions. Add Git sync. This is the highest-ROI reliability decision in the whole plan (`00`: opinionation is a feature).

- **Entry gate:** Phase 1 exit met.
- **Exit gate:** "build a multi-user app with login and persistent data" works **with real data flows, not mocks — and RLS is on by default** in generated schemas.
- **Duration:** ~3–6 weeks.

**Team & skills:** 3–5 engineers; add full-stack/backend depth (Postgres, auth, RLS, storage), plus DX for the provisioning tools. First formal QA/eval attention.

**Budget envelope (monthly):** GPU/inference $3,000–$12,000; sandbox infra $2,000–$8,000; managed backend for generated apps $500–$3,000; team = 3–5 salaries.

**Build-vs-buy:**
| Decision | Recommendation |
|---|---|
| Backend primitives (DB/auth/storage) | **Buy** a managed Postgres/auth/storage backend for generated apps — provision via agent tools. RLS on by default, generated into every schema (`06`, `08`). |
| The opinionated stack | **Build once, support deeply.** Narrow beats general. |
| Git sync | **Buy/adopt** provider APIs; don't reinvent. |

**Weekly metrics (start tiering here):** success rate for "landing page" and "CRUD dashboard" tiers; % of generated schemas with RLS on (must trend to 100%); real-data-flow success rate; iterations and cost per successful build.

---

### 5. Phase 3 — Orchestration + parallelism

**Goal:** planner produces a task DAG; parallel task agents run on **forked (copy-on-write) project state or Git branches**; a verification sub-agent gates merges. Add confirmation gates and the security-analyzer pass on proposed actions (`08`).

- **Entry gate:** Phase 2 exit met.
- **Exit gate:** **two independent features build in parallel and merge without clobbering each other.**
- **Duration:** ~4–6 weeks.

**Team & skills:** 4–6 engineers; add a durable-orchestration specialist (workflow engine) and someone owning the verification sub-agent. Copy-on-write / snapshotting expertise.

**Budget envelope (monthly):** GPU/inference $8,000–$30,000 (parallel agents multiply token spend); sandbox infra $5,000–$20,000 (more concurrent sandboxes + warm pool); team = 4–6 salaries.

**Build-vs-buy — the key Phase 3 decision:**
| Decision | Buy/adopt (Temporal-style durable engine) | Build (custom orchestrator) |
|---|---|---|
| Crash-resume, retries, human-in-loop gates | First-class, battle-tested | Months of subtle bug-hunting |
| **Recommendation** | **Adopt a durable workflow engine.** Agent runs last minutes-to-hours and must survive process restarts (`04`, `06`). Do not hand-roll durability. |  |

**Do this:** copy-on-write forks are what make parallel task agents and "undo the last hour" affordable — invest in cheap snapshots. **Don't do this:** run parallel agents against shared mutable state; you'll get silent clobbering and non-reproducible failures.

**Weekly metrics:** parallel-merge success rate (no clobber); merge-conflict rate; verification-sub-agent catch rate; wall-clock for multi-feature builds; cost per successful deploy (now trackable end-to-end).

---

### 6. Phase 4 — Production hardening

**Goal:** multi-tenant isolation, rate limits, billing/credits, platform auth; full observability (a trace of every agent step); the internal eval harness runs on every change; rollback/checkpoints exposed to users; egress allowlisting, metadata block, secrets discipline, and abuse detection all enforced.

- **Entry gate:** Phase 3 exit met.
- **Exit gate (release blocker):** a **red-team pass fails to escape the sandbox, reach the metadata endpoint, or touch another tenant** (see `08` §3). Plus: eval harness gates every deploy; billing and quotas live.
- **Duration:** ongoing (never truly "done").

**Team & skills:** 6–10 people; add a dedicated **security/trust & safety** owner, an SRE/on-call function (`07`), and eval/QA ownership. Billing/payments integration skills.

**Budget envelope (monthly):** GPU/inference $20,000–$80,000+ (production traffic + always-on eval); sandbox infra $15,000–$60,000; observability/logging $2,000–$10,000; team = 6–10 salaries. **This is where you evaluate owning GPUs** (see §8 formula).

**Build-vs-buy — the key Phase 4 decision:**
| Decision | Buy (managed endpoints) | Build (own GPUs + self-hosted vLLM) |
|---|---|---|
| When | Traffic bursty/uncertain; still finding PMF | Traffic steady and predictable; margin matters |
| Serving | Provider runs vLLM/SGLang | You run **vLLM** (default engine; automatic prefix caching + structured outputs). **Not TGI** — it entered maintenance mode Dec 11, 2025; HF recommends vLLM or SGLang (verified Aug 17, 2026). |
| **Recommendation** | Start bought; **switch to owned when the §8 break-even is clearly crossed and duty cycle is high.** |  |

Also decide here: **self-hosted Firecracker vs continuing with a sandbox provider** — flip to self-hosted when density/margin justify the host-engineering cost (revisits the Phase 1 decision with real volume).

**Weekly metrics (the four real KPIs from `00`/`05`):** success rate, iteration count, **cost per successful deploy**, human-intervention rate — tracked per task tier. Plus: red-team pass status, p95 latency, GPU utilization/duty cycle, abuse-event rate and mean-time-to-contain (`08`), forgotten-endpoint check.

---

### 7. Phase 5 — Openness + differentiation

**Goal:** default to / offer open-model choice via your router; optionally fine-tune on high-quality build-and-deploy traces you collect; add agent templates, connectors (MCP-style), and enterprise features (SSO, audit, VPC/self-host). This is where "unrestricted model choice + code ownership + self-hostable" becomes the marketing spine.

- **Entry gate:** Phase 4 exit met (a hardened platform — openness is layered on hardening, never instead of it).
- **Exit gate:** ongoing; model choice is swappable via the router with **per-model licensing tracked and verified** (`10`), and the model-content vs infrastructure-abuse policy separation (`08`/`10`) is enforced in production.
- **Duration:** ongoing.

**Team & skills:** 8+; add ML/fine-tuning, enterprise/compliance (SSO, audit, VPC), and legal/governance partnership (`10`).

**Budget envelope (monthly):** GPU/inference $40,000–$150,000+ (owned fleet + fine-tuning runs); sandbox infra $30,000+; team = 8+ salaries; plus one-off fine-tuning compute.

**Build-vs-buy:**
| Decision | Recommendation |
|---|---|
| Model router | **Build/adopt** a LiteLLM-style router so models stay swappable — never lock to one model (`03`). |
| Fine-tuning | **Build** only on high-quality traces you own; benchmark every candidate (incl. abliterated) against its base on your eval harness before shipping (`03`, `05`) — de-refused models often regress on multi-step reasoning. |
| Connectors / enterprise | Mix — adopt MCP standards; build SSO/audit/VPC to buyer requirements. |

**Weekly metrics:** open-model adoption %; per-model eval scores vs base; license-compliance coverage (100% of served models tracked); enterprise-feature readiness; retention/expansion.

---

### 8. Cost model — formulas

Plug in your real rates; re-check GPU prices and model licenses before commercial commitments (they are time-sensitive; the architecture is stable, the vendor landscape is not).

**Inference (managed, per month):**
```
inference_$ = Σ_tasks ( avg_tokens_per_task × price_per_token )
            = requests × avg_iterations × tokens_per_iteration × price_per_token
```
Prefix caching (vLLM automatic prefix caching) cuts the effective priced tokens on your shared long system prompt — model it as a discount factor `(1 − cache_hit_fraction)` on prompt tokens.

**Inference (owned GPUs, per month):**
```
owned_$ = num_gpus × gpu_hourly × 730 × (1 / duty_cycle_utilization_factor_for_overhead)
capacity_tokens = num_gpus × throughput_tokens_per_gpu_hour × 730 × utilization
```
**Buy-vs-own break-even:** own when `managed_$(volume) > owned_$` at your steady-state volume **and** duty cycle is high (GPUs mostly busy). Bursty/low-duty traffic favors managed + scale-to-zero.

**Sandbox infra (per month):**
```
sandbox_$ = active_sandbox_hours × cost_per_sandbox_hour
          + warm_pool_size × pool_cost_per_hour × 730
active_sandbox_hours = builds × avg_build_minutes / 60
```
Warm pooling trades idle cost for lower cold-start; size the pool to demand and recycle ephemerally (`07`). Even ~125 ms cold starts add up at high build rates.

**The KPI that governs everything:**
```
cost_per_successful_deploy = (inference_$ + sandbox_$ + backend_$) / successful_deploys
```
A cheap model needing 9 iterations can cost more than an expensive one needing 2. **Optimize this, not cost per token** — route by task difficulty and cache aggressively (`03`, `07`).

**Team cost:** `team_$ = headcount × fully_loaded_monthly_salary`. It dominates every early-phase envelope; treat GPU/sandbox spend as small relative to payroll until Phase 4.

---

### 9. Risk register

| # | Risk | Phase(s) | Likelihood | Impact | Mitigation |
|---|---|---|---|---|---|
| R1 | Sandbox escape / metadata-endpoint exposure → control-plane compromise | 1→ongoing | Low if disciplined | Catastrophic | microVM isolation, default-deny egress, metadata block, red-team gate (`02`, `08`). |
| R2 | Cross-tenant leak | 4→ongoing | Low | Severe | Per-tenant isolation, no shared creds, authenticated preview proxy, cross-tenant red-team (`08`). |
| R3 | Infrastructure abuse (mining/scanning/spam/C2/phishing) at launch | 4→ongoing | High if public without controls | Legal + provider suspension | Egress allowlist + abuse taxonomy detection + automated T0–T3 response (`08`). |
| R4 | Prompt injection / excessive agency | 3→ongoing | Medium | High | Least-privilege tools, confirmation gates, untrusted-content handling (OWASP GenAI 2026 list; `04`, `08`). |
| R5 | Abliterated/de-refused model regresses on coding/reasoning | 5 | Medium | Medium | Always benchmark modified vs base on your eval harness before shipping (`03`, `05`). |
| R6 | Model-license non-compliance for commercial serving | 5 | Medium | High | Per-base-model license tracking + verification before serving (`10`). |
| R7 | Runaway GPU spend / forgotten running endpoint | 1→ongoing | High | Medium | Scale-to-zero, quota alarms, weekly forgotten-endpoint check, track cost-per-deploy (`07`). |
| R8 | Low reliability from an over-general stack | 2→ongoing | High if unopinionated | High (product-killing) | Commit to one opinionated stack, deeply supported (`00`, Phase 2). |
| R9 | Full-file rewrites cause silent regressions | 1→ongoing | Medium | Medium | Prefer diff/patch or AST-aware edits (`04`). |
| R10 | Lost work from crashed long-running agent runs | 3→ongoing | Medium | Medium | Durable workflow engine + CoW checkpoints (`04`, `06`). |
| R11 | Payment-processor / hosting ToS suspension | 4→ongoing | Medium | High | Know processor/hosting AUP before launch; AUP + abuse process (`10`). |
| R12 | Verification too shallow → ships broken apps | 2→ongoing | Medium | High | Layered checks incl. real browser smoke test; measure success rate not benchmark scores (`05`). |

---

### 10. Phase gate summary

| Phase | Exit gate (must be demonstrable) |
|---|---|
| 0 | Loop creates + runs + fixes a trivial app with no human code edits. |
| 1 | CRUD app builds; agent self-corrects ≥1 bug via browser test; real microVM isolation with egress + metadata controls. |
| 2 | Multi-user app with login + persistent real data; RLS on by default. |
| 3 | Two features build in parallel and merge without clobbering. |
| 4 | Red-team fails to escape sandbox / reach metadata / touch another tenant; eval harness gates deploys; billing live. |
| 5 | Open-model choice via router with per-model licensing tracked; content-vs-abuse policy separation enforced. |

**Never advance a phase on schedule alone. The gate is the truth.**
