# 03 — Model Layer and Serving

**Purpose.** This is where "unrestricted" actually lives: open model choice on your own GPUs, behind an OpenAI-compatible surface, swappable by design. This doc specifies the serving architecture (vLLM-first, SGLang alternative, TGI deprecation), the model router (task-difficulty routing, fallbacks, quota), prefix caching and structured outputs, GPU sizing and scale-to-zero economics, the model selection method and internal eval gating, cautions and a benchmarking protocol for abliterated/low-refusal models, and licensing tracking. It builds out Layer 3's engine and the control-plane model router from `01-architecture-blueprint.md`. Crucially: the model layer is the *uncensored* layer; it sits on the *hardened* execution layer in `02-sandbox-and-isolation.md`, and the two are orthogonal.

---

### 0. What "unrestricted" means here — and what it doesn't

"Unrestricted" = **open model choice + code ownership + capability breadth**. On this layer specifically it means: run any open-weight model you want, including low-refusal fine-tunes, on your own GPUs, with no vendor content policy imposed on the *model*, and swap models freely because everything speaks one API.

It does **not** mean the platform will do anything. **"The model won't refuse" ≠ "the platform will do anything."** Your sandbox permissions, egress rules, and abuse detection (`02`, `08`) are unchanged by the model's willingness. That separation is exactly what lets you offer genuine model openness without operating an abuse platform. Model-content policy is a `10-governance-legal-policy.md` question; it is not solved or unsolved here.

---

### 1. Serving architecture — vLLM first

Serve open-weight models behind an **OpenAI-compatible API** so models are swappable and the router (Section 2) never cares which engine is behind a given model.

#### Default: vLLM

- **PagedAttention** gives high throughput under concurrency.
- **Automatic prefix caching** reuses the KV cache when requests share a prefix — a large win when many requests share the same long system prompt, which yours will (the harness prompt is long and stable). Verified against vLLM docs, Aug 17, 2026.
- **Structured outputs** (constrained/guided decoding) let you force valid JSON for tool calls and plans without brittle parsing. Verified against vLLM docs, Aug 17, 2026.

#### Alternative: SGLang

Use SGLang when you want its scheduler/RadixAttention behavior for heavily shared-prefix, multi-turn agent traffic, or its front-end language for structured multi-step generation. It is a first-class alternative; keep the API surface identical so switching is a config change.

#### Do NOT build on TGI

**Text Generation Inference (TGI) entered maintenance mode on Dec 11, 2025, and Hugging Face itself now recommends vLLM or SGLang** (verified against HF Inference Endpoints docs, Aug 17, 2026). Do not start a new serving stack on TGI. If you inherited one, plan migration to vLLM.

| Engine | Status (Aug 17, 2026) | Use it? |
|---|---|---|
| **vLLM** | Active; HF-recommended | **Default.** Prefix caching + structured outputs. |
| **SGLang** | Active; HF-recommended | Alternative for shared-prefix-heavy agent traffic. |
| **TGI** | **Maintenance mode since Dec 11, 2025** | **No** for new builds; migrate off. |

**Standardize the API surface** (OpenAI-compatible) so any of the above — or a managed endpoint, or a commercial model in a hybrid setup — is a drop-in behind the router.

---

### 2. The model router (OpenAI-compatible)

A router (LiteLLM-style or custom) sits in the control plane and is the **only** path from the data plane to any model (`01`, `02`). It presents one OpenAI-compatible endpoint and does four jobs: routing, fallback, quota, and server-side credential injection.

The implemented router also owns the model catalog and per-org/per-project
selection policy. Callers choose catalog model ids and task difficulty only;
they never provide upstream base URLs, credentials, or provider headers. See
`model-choice-router-and-low-refusal-protocol.md` for endpoint shapes and the
server-side validation rules.

#### Task-difficulty routing

Model routing is your biggest cost lever. Do not send a one-line CSS tweak to a 200B planner. Route by the task the orchestrator (`04`) is running:

| Task class | Route to | Why |
|---|---|---|
| Trivial edits, classification, routing decisions | **Small fast model** | Cheap, low latency, high volume |
| Implementation / code editing | **Coding-specialized model** | Best diff/patch and tool-use quality |
| Planning / architecture / task-DAG decomposition | **Strong long-context reasoning model** | Long-horizon reasoning is where cheap models compound errors |
| Hardest planning steps (optional hybrid) | **Commercial model** | Only when your open planner measurably underperforms and the step is high-value |

The orchestrator tags each model call with a task class; the router maps class → model. Never hard-code a model name in the harness (Section 5).

#### Fallbacks

- On a model/endpoint error, timeout, or capacity rejection, fall back to a configured alternate of the **same class** (e.g., secondary coding model), then degrade a class if necessary, and surface an explicit error rather than silently returning a worse result on a critical step.
- Health-check endpoints; drain traffic from an unhealthy replica.

#### Quota and credentials

- Enforce per-tenant quota/credits **before** dispatching (mirrors the gateway check in `01`).
- **Inject inference credentials server-side.** The sandbox never holds a model API key (`02` §3). It calls the router; the router calls the model.

---

### 3. Prefix caching and structured outputs — how to actually use them

#### Prefix caching

Your harness has a long, stable system prompt (tool definitions, conventions, safety framing). vLLM's automatic prefix caching reuses the KV cache across requests that share that prefix.

- **Do this:** keep the shared system prompt **byte-stable and first** in the message list so the cacheable prefix is maximal. Put per-request, variable content (the task, retrieved code) *after* the stable prefix.
- **Don't do this:** inject timestamps, request IDs, or shuffled tool orderings into the system prompt — any per-request variance at the front defeats the cache.
- Result: lower time-to-first-token and higher throughput on your highest-volume traffic (the agent loop hammers the same prefix thousands of times per run).

#### Structured outputs

Use guided/constrained decoding for anything you parse programmatically:

- **Tool calls** → constrain to the tool's JSON schema so you never get a malformed call.
- **Plans / task DAGs** (`04`) → constrain to the DAG schema.
- **Routing/classification** → constrain to the enum of valid labels.
- **Do this:** validate the constrained output against the same schema on receipt (defense in depth). **Don't do this:** free-form-generate JSON and regex it back out — that is a top source of loop-breaking parse failures.

---

### 4. GPU sizing and scale-to-zero economics

The goal is low burn in early development and cost-efficiency at scale. Track **cost per successful deploy, not cost per token** (`07`): a cheap model needing 9 iterations is more expensive than a pricier one needing 2.

#### Sizing method (not fixed hardware — that ages)

1. Pick candidate models per task class (Section 5).
2. Measure, on your target GPU tier, the **tokens/sec at your P95 concurrency** and the **KV-cache memory** needed for your context length × concurrent sequences.
3. Size VRAM to fit weights + KV cache at target concurrency; scale out replicas horizontally rather than over-provisioning one giant node.
4. Re-measure whenever you change model, context length, or concurrency target.

#### Scale-to-zero / pause when idle

- **Scale-to-zero (or pause) every idle GPU endpoint.** A forgotten running endpoint is the classic surprise bill.
- Managed dedicated endpoints (e.g., Hugging Face Inference Endpoints) with pause-on-idle are a reasonable **on-ramp**; self-hosting vLLM on your own GPUs is the cost-efficient **endgame**.
- **Watch GPU quota like a hawk** during the managed-endpoint phase.
- Pair endpoint scale-to-zero with sandbox scale-to-near-zero (`02`, `07`) — both idle costs, both pausable.

> **Pricing note:** GPU hourly rates and endpoint pricing are time-sensitive. Re-check current rates before any commercial commitment; the *method* above is durable, the numbers are not.

---

### 5. Model selection method and internal eval gating

**Do not hard-code "use model X."** The landscape moves monthly; any specific model name is stale within a quarter. The durable asset is the *method*.

#### The method

1. Maintain a small **internal eval harness** (owned by `05-verification-and-evals.md`) of graded build tasks: landing page → CRUD dashboard → multi-user SaaS with payments.
2. Run each candidate through it per task class:
   - Coding-specialized model for implementation.
   - Strong long-context reasoning model for planning.
   - Small model for routing/classification.
3. Gate on the **four real KPIs** (`05`, `07`): **success rate, iteration count, cost per successful deploy, human-intervention rate** — not public benchmark scores alone.
4. **Re-run the harness whenever a notable release lands.** Promote a model to a task class only if it wins on your KPIs.

#### On benchmarks

Public code benchmarks are a **weak proxy** for "did a working app ship." **SWE-bench Verified** — the human-validated 500-problem subset — is the least noisy public option, but it measures issue-fixing in existing repos, not greenfield app delivery (verified, Aug 17, 2026). Use it as a *screen*, never as the gate; your internal harness is the gate.

**Known-good families as a starting point (screen, then gate):** open agentic coding families such as **Qwen3-Coder** (open-weight agentic coding family, released July 22, 2025 — verified) are reasonable first candidates for the implementation class. This is a starting screen, not a recommendation to hard-code.

---

### 6. Abliterated / low-refusal models — read carefully

Abliteration removes the "refusal direction" from a model's activations. It is a legitimate way to get a low-refusal model, **but it can degrade reasoning and coding quality and introduce instability.** That caveat is the important part. Three practical truths:

1. **Refusal behavior and coding capability are correlated in fine-tuning.** Aggressively de-refused models often regress on exactly the multi-step reasoning your agent depends on. **Always benchmark the modified model against its base on your own coding evals before shipping it — never assume the modified version is a free upgrade.**
2. **Model willingness changes nothing about platform capability.** The sandbox, egress, and abuse detection (`02`, `08`) are identical whether the model refuses or not. Openness at the model layer + hardening at the execution layer is the whole design.
3. **Licensing is per-base-model and it is on you** (Section 7).

#### Benchmarking protocol for a candidate low-refusal model

Run this before promoting any abliterated/de-refused model into a task class:

1. **Baseline the base model** on your internal harness (Section 5) — record all four KPIs per tier.
2. **Run the modified model on the identical harness**, same tasks, same seeds where possible.
3. **Compare, don't assume.** Reject if the modified model regresses materially on iteration count, success rate, or cost-per-successful-deploy — a "more willing" model that needs 3× the iterations is a worse model.
4. **Stability check:** run the modified model at your P95 context length and concurrency; watch for degeneration (loops, incoherence, tool-call malformation) that base models don't show.
5. **Document the delta** and the decision in the model registry (Section 7). Re-run on any new revision of the fine-tune.

**Do this:** treat every low-refusal fine-tune as a candidate that must earn its slot on your KPIs. **Don't do this:** swap in an abliterated model because it "won't refuse" and assume capability held.

The CI-facing comparison command is `uv run python -m loopit_evals.cli
compare-models --base-results <base.json> --modified-results <modified.json>`.
It refuses to issue a verdict unless both files are real eval runs and ships
only when no coding/reasoning tier cell significantly regresses.

---

### 7. Licensing tracking

**Open weights are not uniformly permissive.** Some restrict fields of use or commercial resale. Licensing is per-base-model and per-derivative, and it is your responsibility.

- Maintain a **model registry** row per served model and derivative: base model, license, license constraints (fields-of-use, commercial-resale, attribution), source URL, eval KPIs (Section 5), and the abliteration/fine-tune benchmarking result (Section 6).
- **Verify each model's license before commercial serving** — this is a hard gate in the promotion flow, alongside the eval gate.
- The machine-readable register lives in `loopit_model_licenses`; router-svc
  calls `assert_servable_commercially(model_id)` before dispatch, and
  `scripts/check_model_licenses.py` provides the CI audit.
- When you fine-tune on collected traces, track the resulting derivative's license lineage and any user-consent obligations (`10`).

| Registry field | Why it's there |
|---|---|
| base_model, source_url | Provenance |
| license, constraints | Commercial-use gate (verify before serving) |
| task_class, KPIs | Routing + eval gating (Section 5) |
| modification (abliteration/fine-tune) + base-vs-modified KPIs | Section 6 protocol result |
| serving_engine (vLLM/SGLang) | Ops (Section 1) |

---

### 8. Model-layer checklist

- [ ] All models served behind one OpenAI-compatible surface (swappable by design).
- [ ] Serving on **vLLM** (default) or **SGLang**; **not TGI** (maintenance mode since Dec 11, 2025).
- [ ] Prefix caching exploited: system prompt byte-stable and first; variable content after.
- [ ] Structured outputs used for tool calls, plans, and classification; validated on receipt.
- [ ] Router does task-difficulty routing, fallbacks, quota, and **server-side credential injection** (no keys in sandbox).
- [ ] GPU endpoints scale-to-zero / pause on idle; GPU quota watched; cost tracked per successful deploy.
- [ ] No hard-coded model; selection driven by the internal eval harness and the four KPIs.
- [ ] SWE-bench Verified used only as a screen, never as the gate.
- [ ] Every abliterated/low-refusal model benchmarked base-vs-modified before promotion.
- [ ] Model registry tracks license (verified before commercial serving) and constraints per base model and derivative.

The architecture here is stable; the vendor and model landscape is not. Re-check model licenses, GPU pricing, and the current OWASP GenAI list edition before commercial commitments (`10`).
