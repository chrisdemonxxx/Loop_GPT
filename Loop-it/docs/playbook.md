# Part I — Master Playbook

## The Bible: Building an Open, Self-Hosted AI Software-Building Platform

**Prepared:** August 17, 2026
**Depth:** Deep (architecture + execution playbook)
**Status of sourcing:** Verified against live primary sources on August 17, 2026 (Firecracker project docs, Hugging Face Inference Endpoints docs, vLLM docs, OWASP GenAI project). Descriptions of *closed* commercial products' internals remain informed inference, not fact.

---

### 0. Framing: what "unrestricted" can and cannot mean

The word "unrestricted" collapses four very different things. Separating them is the single most important decision in this whole project, because three of them are cheap and one of them will destroy you.

| Dimension | "Unrestricted" version | Verdict |
|---|---|---|
| **Model choice** | Run any open-weight model you want, including low-refusal fine-tunes, on your own GPUs. No vendor content policy imposed on the *model*. | Legitimate and fully achievable. This is the real product. |
| **Product openness** | User owns the code, exports to Git, no lock-in, self-hostable. | Legitimate and a genuine differentiator. |
| **Capability breadth** | Full Linux, real package managers, real browsers, real deploys — the agent can actually do things. | Legitimate; this is table stakes for a serious platform. |
| **Removing isolation / abuse controls** | No sandbox, no tenant separation, no egress limits, no abuse detection. | **Do not do this.** It is not a feature; it is an unpatched vulnerability. A platform that runs arbitrary AI-generated code with no isolation becomes a botnet, a crypto-miner host, and a data-exfiltration relay within hours of going public. |

The rest of this playbook builds the first three aggressively and treats the fourth as a hard boundary. You get an uncensored *model layer* sitting on top of a *hardened execution layer*. Those are orthogonal. The model can be willing to write anything; the sandbox still must not let that code touch your control plane or another tenant.

---

### 1. What these platforms actually are

The uploaded summary's core thesis is correct and worth restating precisely: **none of these systems is "one LLM that emits code."** They are *agent harnesses* — orchestration loops that wrap one or more models with tools, memory, a sandboxed runtime, a verification feedback loop, and a deployment boundary. The model is the engine; the harness is the car.

The shared pattern across Replit Agent, Lovable, Emergent, Hercules, and the open-source analog OpenHands is a five-stage loop:

**Natural language → structured plan → code/infra changes in a sandbox → run + observe + test → iterate → deploy.**

The differences between them are mostly about *where they sit on three sliders*:

- **Autonomy vs. control** — Emergent leans hands-off for non-technical founders; Replit Agent gives developers more steering and checkpoints. Neither extreme is "better"; they serve different buyers.
- **Opinionation of the stack** — Lovable's reliability comes from refusing to be a general IDE. It generates one stack (React + Tailwind + a managed Postgres/auth backend) extremely well. This is the most under-appreciated lesson in the uploaded doc: **opinionation is a feature, not a limitation.** A narrow, deeply-supported stack produces far higher success rates than a general agent that can theoretically do anything and reliably does nothing.
- **Verification investment** — the platforms that feel "magic" are the ones that actually *run the app and click through it* before showing the user. This is the real moat, and it is discussed in detail in Section 6.

**Confidence note:** Architecture *patterns* here are high-confidence and cross-corroborated by open-source implementations. Specific internal details of the closed products (exact agent graphs, prompts, model routing) are unverifiable from public sources and should never be treated as known.

---

### 2. Reference architecture

Think in **planes**. The cardinal security rule of the entire system is: *agent-generated code executes only in the data plane, never anywhere else.* Every serious incident in this class of product traces back to a violation of that rule.

```
┌─────────────────────────────────────────────────────────────┐
│ CONTROL PLANE  (trusted, never runs generated code)          │
│  - API / auth / billing / quota                              │
│  - Orchestrator (durable workflow engine)                    │
│  - Job queue + sandbox scheduler                             │
│  - Model router (LiteLLM-style) → inference backends         │
│  - Secrets manager, audit log, observability                 │
└───────────────┬─────────────────────────────────────────────┘
                │ signed, least-privilege RPC
┌───────────────▼─────────────────────────────────────────────┐
│ DATA PLANE  (untrusted, ephemeral, isolated per project)     │
│  - Sandbox = microVM/container: full Linux, shell, Node/Py   │
│  - Project filesystem (copy-on-write for forks/checkpoints)  │
│  - Headless browser for self-testing (Playwright)            │
│  - Preview server exposed via authenticated reverse proxy    │
│  - Strict egress allowlist; no metadata endpoint access      │
└───────────────┬─────────────────────────────────────────────┘
                │ explicit deploy action only
┌───────────────▼─────────────────────────────────────────────┐
│ DEPLOYMENT PLANE  (the user's running app)                   │
│  - Managed hosting or user's own cloud                       │
│  - Its own DB, auth, storage, secrets — separate from build  │
└─────────────────────────────────────────────────────────────┘
```

### The eight layers (mapped from the uploaded doc, sharpened)

1. **Interaction** — chat + live preview (iframe/WebContainer-style) + optional visual editor + a task board so long autonomous runs are legible.
2. **Orchestration / harness** — the planner that decomposes work into a task DAG, the tool-calling loop, and *context management* (file indexing, two-stage retrieval, summarization/condensing for long sessions). This is where most of your engineering effort actually goes.
3. **Code generation & editing** — prefer **diff/patch application** or AST-aware edits over full-file rewrites. Full-file rewrites are the number-one cause of silent regressions in these systems. The "CodeAct" idea (the agent emits executable code rather than rigid JSON tool calls) buys flexibility but needs tighter sandboxing.
4. **Sandbox / runtime** — see Section 3. Non-negotiable.
5. **Verification loop** — unit/integration tests plus a real headless browser that exercises the app and feeds failures back. See Section 6.
6. **Infrastructure provisioning** — tools that create DB schemas, auth, storage, row-level-security policies, edge functions, and seed data.
7. **Deployment boundary** — one action, explicit, with its own credentials, plus Git sync and env-var management.
8. **Observability & safety** — every action/observation logged, confirmation gates for destructive steps, a policy check on proposed actions, hard multi-tenant isolation.

---

### 3. Sandbox isolation — the part you cannot cut

The uploaded doc calls sandbox security "non-negotiable." That is exactly right and deserves expansion, because this is where an "unrestricted" ambition is most tempting to get wrong.

### The isolation ladder (weakest → strongest)

| Option | Isolation strength | Cold start | Best for |
|---|---|---|---|
| Plain Docker containers | Weakest — shared kernel; a kernel exploit escapes to host | ~fast | **Not sufficient alone** for untrusted multi-tenant code |
| gVisor (userspace kernel) | Strong — syscalls intercepted; smaller kernel attack surface | low overhead | Good middle ground; some syscall-compat gaps |
| Kata Containers | Strong — real VM per container, OCI-compatible | moderate | Container ergonomics with VM boundary |
| Firecracker microVMs | Strong — minimal-device KVM VMs; **<125 ms boot, <5 MiB overhead per microVM, up to 150 microVMs/s creation per host** (verified, official project figures) | very low | The gold standard for this workload; what E2B-class sandboxes use |

**Recommendation:** microVMs (Firecracker) or a Firecracker-based sandbox provider for untrusted execution. If you must start on containers to move fast, wrap them in gVisor and treat that as temporary. Never run tenant code in bare Docker sharing the host kernel.

### The controls that matter more than the runtime choice

- **Ephemerality.** Sandboxes are cattle. One project (or one fork) gets a fresh sandbox; it is destroyed after. State lives in the copy-on-write project filesystem, snapshotted for checkpoints — not in a long-lived VM.
- **Egress control is the single highest-leverage security measure.** Default-deny outbound network. Allowlist only what a build genuinely needs (package registries, the model endpoints via the control plane, chosen APIs). This alone neutralizes most exfiltration, C2, and abuse-as-a-service scenarios — and it is the control most often skipped.
- **Block the cloud metadata endpoint** (`169.254.169.254` and equivalents). Unblocked, it is a direct route to your infrastructure's credentials. This is the classic single misconfiguration that turns a sandbox escape into a full account takeover.
- **No ambient credentials in the sandbox.** The sandbox never holds your platform's cloud keys, DB admin creds, or other tenants' secrets. It reaches the model *only* through the control-plane router, which injects credentials server-side and enforces quota.
- **Resource caps + kill switches.** CPU/memory/disk/time limits per run; automatic termination of crypto-miner-shaped workloads (sustained max CPU, known mining pool traffic).
- **Prompt-injection is an architectural threat, not a content-filter problem.** A malicious webpage, README, or dependency the agent reads can hijack it into running attacker instructions. Mitigate structurally: least-privilege tools, confirmation gates on destructive/irreversible actions, treating all fetched content as untrusted data, and never letting tool output silently escalate permissions. (Maps to the OWASP GenAI LLM Top 10 — Prompt Injection and Excessive Agency; the current release is the **2026** list, superseding the 2023 v1.1 and 2025 editions. Verified against the OWASP GenAI project.)

### Four distinct threat classes (keep them separate in your head)

1. **Control-plane compromise** — catastrophic; the entire defense above exists to prevent it.
2. **Tenant escape** — one project reaching another's data; prevented by per-tenant isolation + no shared credentials.
3. **App-level vulnerabilities** — bugs in the *generated* app. Mitigate with a security analyzer / SAST pass on output and safe-by-default templates (parameterized queries, RLS on by default, no secrets in client code).
4. **Infrastructure abuse** — your compute/network used for mining, scanning, spam, C2, or phishing hosting. Mitigate with default-deny egress plus abuse detection and response.

(**Model misuse** — the model producing disallowed *content* — is deliberately not on this list: it is a *policy and jurisdiction* question, addressed in Section 9, and completely separate from the four infrastructure threats above.)

---

### 4. Model layer — the actual "unrestricted" part

This is where your stated goal lives, and where the uploaded doc is broadly sound but needs a few corrections and cautions.

### Serving

- **vLLM (default) or SGLang behind an OpenAI-compatible API.** vLLM's PagedAttention gives high throughput, and its automatic prefix caching reuses the KV cache when requests share a prefix — a huge win when many requests share the same long system prompt (yours will). **Do not build on TGI: it entered maintenance mode on Dec 11, 2025, and Hugging Face itself now recommends vLLM or SGLang** (verified, HF Inference Endpoints docs). Standardize the API surface so models are swappable.
- **Scale-to-zero / pause when idle** to control GPU spend during early development. Managed dedicated endpoints (e.g., Hugging Face Inference Endpoints) are a reasonable on-ramp; self-hosting vLLM on your own GPUs is the cost-efficient endgame.
- **A router in front** (LiteLLM-style or custom) so you can do multi-model workflows: a strong reasoning model for planning, a coding-specialized model for implementation, a small fast model for trivial edits/classification, and optionally a commercial model for the hardest planning steps in a hybrid setup.

### On "abliterated" / low-refusal models — read this carefully

The uploaded doc is honest that abliteration (removing the refusal direction from activations) **can degrade reasoning and coding quality and introduce instability.** That caveat is the important part. Three practical truths:

1. **Refusal behavior and coding capability are correlated in fine-tuning.** Aggressively de-refused models often regress on exactly the multi-step reasoning your agent depends on. *Always benchmark the modified model against its base on your own coding evals* before shipping it — never assume the modified version is a free upgrade.
2. **"The model won't refuse" ≠ "the platform will do anything."** Your sandbox permissions, egress rules, and abuse detection are unchanged by the model's willingness. This separation is what lets you offer model openness without offering an abuse platform.
3. **Licensing is per-base-model and it is on you.** Open weights are not uniformly permissive; some restrict fields of use or commercial resale. Track the license of every base model and derivative you serve, and re-read each license immediately before any commercial use — licenses and their interpretations change.

### Model selection method (not a fixed list — the landscape moves monthly)

Do not hard-code "use model X." Build a small internal eval harness (Section 6) and run candidates through it: a strong open coding-model family for implementation, a strong long-context reasoning model for planning, a small model for routing/classification. Re-run the harness whenever a notable release lands. The *method* is durable; any specific model name (in the uploaded doc or this one) is likely stale within a quarter — re-run the harness rather than trusting a written list.

---

### 5. Control plane, projects, and deployment

The uploaded doc under-specifies the SaaS scaffolding around the agent. This is where a lot of the real product is.

### Data model (minimum viable)

`User → Project → {Files (CoW snapshots = Checkpoints), Runs/Jobs, Sandbox lease, Database, Secrets, Deployments, Git remote, Connectors}`.

- **Checkpoints via copy-on-write** of the project filesystem (and, where relevant, the project DB) give you cheap forks and instant rollback. The uploaded doc correctly notes Replit-style task agents run on *forked* project state — this is why. Copy-on-write is what makes parallel task agents and "undo the last hour" affordable.
- **Durable orchestration.** Agent runs are long (minutes to hours) and must survive process restarts. Use a durable workflow engine (Temporal-style) so a crash resumes rather than loses an hour of work, retries are principled, and human-in-the-loop approval gates are first-class. (Check the current API of whichever engine you pick at adoption time.)
- **Secrets** live in the control-plane secrets manager, injected into the *deployed app* at deploy time and into the *sandbox* only when a specific build step genuinely needs a specific key — never broadcast.

### Deployment plane

- One explicit deploy action. Options, roughly in order of control: managed hosting you operate → push-to-Git + provider CI/CD (Vercel/Railway/Fly/Cloudflare) → user's own cloud via their credentials.
- The deployed app gets its **own** database, auth, storage, and secrets, fully separate from the build sandbox. A compromised build must never reach production data, and vice versa.
- Preview URLs must be **authenticated and per-project**, served through a reverse proxy — not raw open ports. An unauthenticated preview is a data leak waiting to happen.

### Multi-tenancy

Namespace isolation + network policies + per-tenant credentials + no shared sandboxes for untrusted code. If you use a shared managed backend (Postgres/auth/storage) for generated apps, **row-level security must be on by default** and generated into every schema — not left to the model to remember.

---

### 6. Verification — the real moat

If you build only one thing better than the competition, build this. The platforms that feel magical are the ones that *run the app and test it* before handing it back.

- **Inside every sandbox:** a headless browser (Playwright). After a change, the agent navigates the app, clicks through the primary flows, checks that pages render and APIs respond, and reads console/network errors.
- **Feed failures back into the loop.** The observation ("button X threw 500", "page Y blank, console shows undefined") becomes the next planning input. This reflection loop is what converts a plausible-looking app into a working one.
- **Layer the checks:** typecheck/lint (cheap, run always) → unit/integration tests → browser smoke test of critical paths → optional visual diff. Cheapest checks first; expensive browser runs only when cheap checks pass.
- **Your internal eval harness** (distinct from the per-run verification) measures the *platform* over time: a graded suite of build tasks from "landing page" → "CRUD dashboard" → "multi-user SaaS with payments." Track, per tier: **success rate, iteration count, cost per successful deploy, and human-intervention rate.** These four numbers are your real KPIs — code-generation benchmark scores are a weak proxy for "did a working app ship." (SWE-bench **Verified** — the human-validated 500-problem subset — is the least noisy public option, but it measures issue-fixing in existing repos, not greenfield app delivery; verified.)

---

### 7. Economics and operations

- **Model routing is your biggest cost lever.** Do not send a one-line CSS tweak to a 200B planner. Route by task difficulty; cache aggressively (prefix caching on shared system prompts, result caching for deterministic steps).
- **Scale-to-zero everything idle** — GPU endpoints and sandboxes both. Usage-based sandbox providers and pausable endpoints keep early burn low.
- **Sandbox pooling.** Cold-start even at ~125ms adds up; keep a warm pool sized to demand, recycle ephemerally.
- **Watch GPU quota like a hawk** in the HF-endpoints phase; a forgotten running endpoint is the classic surprise bill.
- **Track cost per successful deploy**, not cost per token. A cheap model that needs 9 iterations is more expensive than an expensive one that needs 2.

---

### 8. Execution roadmap

This adapts the uploaded doc's phases into something with clearer gates. Timelines assume a small, senior team and are directional.

### Phase 0 — Foundations (1–2 weeks)
Stand up a minimal ReAct/CodeAct loop (OpenHands is the fastest on-ramp) against one open model endpoint. Add file-edit + bash tools. Prove "build a todo app" end to end in a throwaway sandbox. **Gate:** the loop can create, run, and fix a trivial app without you touching the code.

### Phase 1 — Core loop + real sandbox (2–4 weeks)
Integrate a real isolated sandbox (microVM-based). Implement plan → code → execute → observe → iterate. Add two-stage codebase retrieval and context condensation for longer sessions. Add basic Playwright smoke testing. **Gate:** a CRUD app builds and the agent self-corrects at least one introduced bug via the browser test.

### Phase 2 — Opinionated full-stack generation (3–6 weeks)
Pick **one** stack and support it deeply (e.g., a React/Tailwind frontend + a managed Postgres/auth/storage backend). Give the agent provisioning tools: schema, auth, RLS, storage, seed data, edge functions. Add Git sync. **Gate:** "build a multi-user app with login and persistent data" works with real data flows, not mocks — and RLS is on by default.

### Phase 3 — Orchestration + parallelism (4–6 weeks)
Planner produces a task DAG; parallel task agents run on forked (copy-on-write) project state or Git branches; a verification sub-agent gates merges. Add confirmation gates and the security-analyzer pass on proposed actions. **Gate:** two independent features build in parallel and merge without clobbering each other.

### Phase 4 — Production hardening (ongoing)
Multi-tenant isolation, rate limits, billing/credits, platform auth. Full observability (a trace of every agent step). The internal eval harness runs on every change. Rollback/checkpoints exposed to users. Egress allowlisting, metadata-endpoint block, secrets discipline, abuse detection all enforced. **Gate:** a red-team pass fails to escape the sandbox, reach the metadata endpoint, or touch another tenant.

### Phase 5 — Openness + differentiation (ongoing)
Default to / offer open-model choice via your router. Optionally fine-tune on high-quality build-and-deploy traces you collect. Add agent templates, connectors (MCP-style), and enterprise features (SSO, audit, VPC/self-host). This is where "unrestricted model choice + code ownership + self-hostable" becomes the marketing spine.

---

### 9. Governance, legal, and abuse — the boundary that keeps you alive

An open model layer does not exempt you from operating a responsible platform. The uploaded doc's own limitations section says the same; here it is made concrete.

- **You are responsible for what your infrastructure does**, regardless of which model produced the code. Egress control, abuse detection (mining, mass-scanning, spam, C2 traffic shapes), and a real abuse-response process are operational necessities, not optional polish.
- **Keep model-content policy and infrastructure-abuse policy separate.** You can permit an uncensored *model* while still refusing to be a *malware host* — those are different layers with different controls. Conflating them is the mistake that either neuters your product or gets it taken offline.
- **Licensing:** per-base-model, tracked, and re-verified against the license text before commercial serving of each model.
- **Jurisdiction and payments:** payment processors and hosting providers have their own acceptable-use terms that bind you regardless of your model policy. Know them before launch, not after a suspension.
- **Data handling:** user code and prompts are sensitive. Encryption at rest and in transit, tenant isolation, and clear retention/training-use policies. If you fine-tune on user traces, that must be disclosed and consented.

---

### 10. Assessment of the uploaded analysis

| Claim in the uploaded doc | Assessment |
|---|---|
| These platforms are agent harnesses, not single LLM calls | **Correct, high confidence.** The central and most useful insight. |
| Five-stage loop (NL → plan → sandboxed code → test → deploy) | **Correct**; cross-corroborated by open-source implementations. |
| Sandbox isolation is non-negotiable | **Correct and under-emphasized relative to its importance.** Expanded in Section 3. |
| Verification/browser testing is a major differentiator | **Correct**; this is the real moat (Section 6). |
| Opinionated stacks drive reliability | **Correct and under-weighted.** One of the highest-ROI decisions. |
| microVM cold-start figures, model names, HF pricing/GPU rates | **Now verified:** Firecracker figures confirmed (<125 ms, <5 MiB, 150 VMs/s). Qwen3-Coder confirmed as a real open-weight agentic coding family (July 2025). One correction: TGI is in maintenance mode (Dec 2025) — use vLLM/SGLang. Pricing remains time-sensitive; re-check GPU rates at purchase time. |
| Internals of closed products (Emergent/Lovable/Hercules valuations, exact agent graphs) | **Treat as inference** — the doc itself flags these as reverse-engineered and they are unverifiable from public sources. Do not build on them as fact. |
| Abliterated models: capability can degrade, benchmark vs base | **Correct and important.** The key caution to honor. |
| "Unrestricted is generally fine legally; downstream use is your responsibility" | **Directionally right but incomplete.** Section 9 adds the operational-abuse and processor/hosting-ToS realities the doc glosses over. |

---

### 11. Decision checklist (start here)

1. **Commit to one opinionated stack.** This decision, more than any model choice, determines your reliability.
2. **Pick your isolation runtime** (microVM strongly preferred) and enforce default-deny egress + metadata-endpoint block from day one.
3. **Stand up the model router early** so models are swappable and you're never locked to one.
4. **Build the internal eval harness before scaling** — you cannot improve what you don't measure; optimize cost-per-successful-deploy.
5. **Invest in the browser-verification loop** — it is your differentiator.
6. **Separate the four planes** (control / data / deployment / user-app) and never let generated code run outside the data plane.
7. **Keep model-content policy separate from infrastructure-abuse policy** — this is what makes "open model layer" viable and durable.
8. **Re-check the fast-moving facts before commercial commitments** — model licenses, GPU pricing, and the current OWASP GenAI list edition. The architecture is stable; the vendor landscape is not.

---

*Sourcing note: verified against primary sources on August 17, 2026 — Firecracker project documentation (boot/overhead/density figures), Hugging Face Inference Endpoints docs (TGI maintenance mode, vLLM/SGLang recommendation), vLLM documentation (automatic prefix caching, structured outputs), and the OWASP GenAI project (LLM Top 10, current release 2026). Closed-product internals remain informed inference. Prices and model licenses are time-sensitive — re-check before commercial reliance.*
