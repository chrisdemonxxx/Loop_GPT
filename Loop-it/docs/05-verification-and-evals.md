# 05 — Verification and Evals: The Verification Moat

**Purpose:** Verification is the single feature that separates a platform that *feels magical* from one that ships plausible-looking apps that don't run. This doc specifies two distinct systems — the **per-run verification loop** that lives inside every sandbox and gates what the user sees, and the **internal platform eval harness** that measures the platform's own quality over time — plus the cost-ordered layering that makes verification affordable, the failure-feedback mechanism that turns errors into progress, the caveats around public benchmarks like SWE-bench Verified, and the regression gate that must run on every platform change. It deepens the "verification is the moat" bet in `00-blueprint.md` (§2) and Section 6 of the research playbook, and assumes the plane separation defined in `01-architecture-blueprint.md`.

> **Hard boundary (inherited, non-negotiable):** All verification code — typecheck, tests, browser drivers, visual diff — executes **only in the data plane** (the sandbox, see `02-sandbox-and-isolation.md`), never in the control plane. The control plane only *reads* structured verification results over signed, least-privilege RPC. A browser that renders agent-generated app code is running untrusted code and belongs in the sandbox with everything else.

---

### 1. Two systems, one word

"Verification" is overloaded. Keep these two apart at all times; they have different owners, cadences, and consumers.

| System | Scope | Runs when | Consumes | Consumed by |
|---|---|---|---|---|
| **Per-run verification loop** | One project, one agent run | Every code change during a run | The project under construction | The agent loop (`04-orchestration-and-agent-loop.md`) and the end user |
| **Internal eval harness** | The whole platform | On every platform change (CI gate) + nightly | A fixed suite of graded build tasks | Platform engineers, release gate, KPI dashboards |

The per-run loop answers **"does this specific app work right now?"** The eval harness answers **"did our last change to the platform make it better or worse at building apps?"** Confusing them is how teams end up shipping a model swap that quietly tanks success rate because "the demo looked fine."

---

### 2. The per-run verification loop

#### 2.1 The layered checks, in cost order

Cheapest checks first. Expensive checks run **only when everything cheaper has passed.** This ordering is not a nicety — a browser smoke test can cost 50–200× a typecheck in wall-clock and compute, and running it against code that won't even compile is pure waste.

| Layer | Check | Typical wall-clock | Relative cost | Gate rule |
|---|---|---|---|---|
| L0 | Typecheck + lint (`tsc --noEmit`, `eslint`, formatter) | 1–5 s | 1× | Always run. Must pass before L1. |
| L1 | Unit + integration tests (`vitest`/`jest`, API-level) | 5–30 s | 3–10× | Run only if L0 clean. Must pass before L2. |
| L2 | Browser smoke test (Playwright: load app, click primary flows, read console/network) | 20–120 s | 50–200× | Run only if L1 clean. Gates what the user sees. |
| L3 | Visual diff (screenshot vs. baseline, per key route) | +5–20 s over L2 | +small on top of L2 | Optional; run only if L2 clean and a visual baseline exists. |

**Decision rule for what to run:** climb the ladder; stop at the first failure and feed it back (Section 2.3). Never skip a lower rung to reach a higher one. Never run L2 on a red L0.

**Decision rule for L3:** only meaningful once a route has a *committed, human-or-agent-approved* baseline. On the first build of a route there is no baseline, so L3 records one and does not gate. Treat visual diffs as **advisory** (surface to the agent and user) rather than hard-failing, because pixel churn from legitimate design changes is high — a red visual diff should prompt "is this intended?" not an automatic loop iteration.

#### 2.2 What the browser smoke test must actually do

A Playwright smoke test that only checks "page returned 200" is theater. The differentiator is *behavioral* verification. For each critical path:

- **Navigate** to the route as a real user would (through the authenticated preview proxy, see `06-control-plane-and-deployment.md`).
- **Assert render:** the expected primary element is present and visible (not a blank body, not an error boundary).
- **Exercise the flow:** click the primary CTA, submit the primary form, trigger the primary data fetch.
- **Read the evidence channels:** capture `console` errors/warnings, failed network requests (4xx/5xx), unhandled promise rejections, and hydration errors. These are the highest-signal failure sources and the ones a naive test misses.
- **Check data round-trips for real:** if the app writes a row, read it back. Verify against **real data flows, not mocks** — a "working" CRUD app that only mocks its API is the classic false green.

**Do this:** derive the critical-path list from the plan/task DAG the planner produced, so verification tracks intent.
**Don't do this:** hand-maintain a static list of routes to click — it drifts from what the agent actually built.

#### 2.3 Feeding failures back into planning

Verification is worthless if its output is a boolean. The loop's value is that a **structured, localized observation** becomes the next planning input.

A failure record fed back to the agent (`04-orchestration-and-agent-loop.md`) should contain:

```
{
  "layer": "L2-browser",
  "route": "/dashboard",
  "flow": "create-invoice",
  "symptom": "POST /api/invoices -> 500",
  "evidence": {
    "console": ["TypeError: cannot read 'id' of undefined at invoice.ts:42"],
    "network": [{"url": "/api/invoices", "status": 500}],
    "screenshot": "artifact://run/r1a2/step-14.png"
  },
  "suspected_files": ["src/api/invoices.ts", "src/db/schema.sql"]
}
```

**Decision rules for the feedback loop:**

- **Localize before you loop.** Attach suspected files (from stack traces and the code-retrieval index) so the agent edits a diff, not a rewrite. Full-file rewrites in response to a test failure are the number-one cause of *new* regressions — see the code-editing guidance in `01-architecture-blueprint.md`.
- **Cap iterations.** A hard ceiling (default: **6** verify→fix cycles per task, **3** on a single unchanged symptom) prevents infinite thrash. On ceiling breach, escalate to a human-intervention gate rather than burning tokens.
- **Detect oscillation.** If the same symptom recurs after a fix attempt, or two fixes ping-pong the same test red↔green, stop and escalate — the agent is guessing.
- **Never show unverified output as "done."** The user-facing "ready" state requires L0–L2 green. If verification can't pass within the iteration cap, present the app with an explicit "known issues" list, not a false success.

#### 2.4 Per-run verification checklist

- [ ] L0 (typecheck + lint) runs on every change, always, first.
- [ ] L1 (unit/integration) gated on L0 green.
- [ ] L2 (browser smoke of critical paths) gated on L1 green, exercises real flows and reads console/network.
- [ ] L3 (visual diff) advisory, only with a baseline.
- [ ] Data round-trips verified against real backends, not mocks.
- [ ] Failures fed back as localized, structured records with suspected files.
- [ ] Iteration cap + oscillation detection enforced; ceiling breach escalates to a human gate.
- [ ] No "done" state shown to the user without L0–L2 green.
- [ ] All of the above runs inside the sandbox; only structured results cross to the control plane.

---

### 3. The internal eval harness

You cannot improve what you do not measure. The eval harness is a **fixed, versioned suite of build tasks** that the platform must complete end-to-end, graded by tier, run on every platform change. Build it before you scale — it is Decision-Checklist item 4 in the playbook.

#### 3.1 Graded task tiers

Tasks are grouped into escalating tiers. Each tier is a set of concrete prompts with machine-checkable acceptance criteria (an oracle: a Playwright script + assertions that only the *correct* app passes).

| Tier | Example task | Acceptance oracle (must pass) |
|---|---|---|
| T0 — Static | "Landing page for a coffee shop with hours and a contact form" | Page renders; form posts; no console errors |
| T1 — CRUD | "Task dashboard: add/edit/delete/list tasks, persisted" | Create→read→update→delete round-trips against real DB |
| T2 — Auth + multi-user | "Notes app with email login; users see only their notes" | Two users; RLS enforced; user A cannot read user B's rows |
| T3 — SaaS + payments | "Subscription SaaS: signup, paywall, Stripe test checkout, gated content" | Checkout completes in test mode; entitlement gates content; webhook updates state |
| T4 — Multi-feature/parallel | "CRM with contacts, deals pipeline, and activity log" | All three modules functional; no cross-module clobbering |

**Rules for the suite:**

- **Freeze prompts and oracles under version control.** Changing a task = a new suite version. Never quietly edit an oracle to make a red result go green.
- **Real data flows in oracles.** The oracle must fail a mocked-backend "solution."
- **Deterministic acceptance, tolerant execution.** The oracle assertions are exact; allow the agent nondeterminism (temperature, model variance) by running each task **N=3** times and reporting distributions, not single runs.
- **Grow the suite from real failures.** When a production build fails in a novel way, distill it into a new eval task. The suite is your regression memory.

#### 3.2 The four KPIs (these are the real numbers)

Code-generation benchmark scores are a weak proxy for "a working app shipped." Track these four per tier, over time. Cost-per-successful-deploy is the north star (it also anchors `07-operations-runbook.md`'s cost dashboards).

| KPI | Definition | Why it matters | Watch for |
|---|---|---|---|
| **Success rate** | % of runs whose app passes the tier oracle | Headline quality signal | Drops on model/prompt/tool changes |
| **Iteration count** | Mean verify→fix cycles to green | Efficiency + loop health | Rising count = degraded reasoning even if success holds |
| **Cost per successful deploy** | Total compute+model $ / successful runs | The economic truth | A cheap model with 9 iterations beats an expensive one with 2 *only if the math says so* |
| **Human-intervention rate** | % of runs that hit an escalation/approval gate | Autonomy signal | Rising rate = the loop is guessing or oracles are too strict |

**Decision rule (cost vs. capability):** never compare models on price-per-token. Compare on **cost per successful deploy** at equal or better success rate. A model that is 2× the token price but halves iteration count is usually cheaper per shipped app. This is the same lever documented in `03-model-layer-and-serving.md` (routing) and `07-operations-runbook.md` (dashboards).

#### 3.3 Reporting

- Emit one row per (suite version, platform commit, model config, tier, KPI) to the metrics store.
- Dashboard: KPI trend lines per tier, with the release commit annotated on the x-axis so a regression is visually traceable to the change that caused it.
- Alert on: success-rate drop >5 pts tier-over-release, or cost-per-successful-deploy up >20% release-over-release.

---

### 4. SWE-bench Verified: use it, but know its limits

**SWE-bench Verified** is the human-validated 500-problem subset of SWE-bench — the least noisy public option for comparing coding models, and worth running as *one* external signal. But understand exactly what it measures (verified Aug 17, 2026).

**What it is:** 500 human-validated real-world GitHub issues; the model must produce a patch that makes the repo's hidden tests pass. Human validation removed under-specified and broken tasks, so it is far cleaner than raw SWE-bench.

**What it measures:** **issue-fixing inside an existing repository** with existing tests.

**What it does NOT measure — and why you cannot ship on its score alone:**

| SWE-bench Verified | Our platform's real job |
|---|---|
| Fix a bug in an existing, well-structured repo | Build a *greenfield* app from a one-line prompt |
| Tests already exist and define correctness | No tests exist; the agent must also decide what "correct" means |
| No infra provisioning | Must provision DB, auth, RLS, storage, deploy |
| No browser/UX correctness | UX must actually render and be clickable |
| Single, localized patch | Multi-file, multi-service, iterative build |

**Decision rules:**

- Use SWE-bench Verified as a **candidate-screening** signal when evaluating a new coding model (a floor: a model that's weak here is unlikely to be strong for us), then gate the real decision on **our internal harness KPIs** (Section 3).
- **Never** put a SWE-bench number in a user-facing reliability claim as a proxy for "builds working apps." They are different tasks.
- Re-verify the current benchmark landscape at evaluation time — benchmarks drift and saturate; the *method* (screen externally, decide internally) is durable, specific leaderboard positions are not.

---

### 5. Regression gating on every platform change

Any change to the platform can silently move the KPIs: a model swap, a prompt edit, a tool change, a sandbox base-image bump, a router policy tweak, a context-management change. **Every one of these is gated by the eval harness.**

#### 5.1 What counts as a gated change

- Model version, routing policy, or serving-config change (`03-model-layer-and-serving.md`).
- Any prompt, planner, or tool-schema change (`04-orchestration-and-agent-loop.md`).
- Sandbox base image, dependency, or resource-limit change (`02-sandbox-and-isolation.md`).
- Verification-layer changes (this doc) — yes, the verifier is itself gated.
- Context retrieval/condensation changes.

#### 5.2 The gate (CI runbook)

1. **Trigger:** PR touching any gated surface, or a nightly scheduled run.
2. **Run** the frozen eval suite (current version) at N=3 per task across all tiers.
3. **Compute** the four KPIs per tier and diff against the last green baseline on `main`.
4. **Gate decision:**
   - **Block merge** if success rate drops >5 pts on any tier, OR cost-per-successful-deploy rises >20%, OR human-intervention rate rises >10 pts.
   - **Warn (non-blocking)** on smaller regressions; require an explicit acknowledgment in the PR.
   - **Pass** if within thresholds.
5. **Record** the KPI row against the commit for the trend dashboard.
6. **On block:** the change does not ship until KPIs recover or the regression is explicitly signed off by an owner with a documented rationale.

#### 5.3 Model rollout coupling

Model rollouts get the **same** gate plus a canary, coordinated with `03-model-layer-and-serving.md` and the rollout procedure in `07-operations-runbook.md`:

- New model must pass the full eval suite offline **before** any traffic.
- Canary to a small % of real runs; watch live success rate and cost-per-successful-deploy against the incumbent.
- Auto-rollback if the canary's live KPIs regress past threshold. Never big-bang a model swap into production.

#### 5.4 Regression-gate checklist

- [ ] Eval suite is versioned and frozen; oracles are never edited to force green.
- [ ] Every gated surface (model, prompt, tool, sandbox image, verifier, retrieval) triggers the gate.
- [ ] N=3 runs per task; KPIs reported as distributions.
- [ ] Merge blocked on threshold breach; overrides require documented owner sign-off.
- [ ] Model changes additionally require offline pass + canary + auto-rollback.
- [ ] KPI rows recorded per commit; dashboards annotate releases.

---

### 5.5 Worked example: a model swap that looks fine but isn't

A concrete illustration of why the gate exists. An engineer swaps the implementation coding model for a cheaper one that scores *higher* on SWE-bench Verified.

| Signal | Before swap | After swap | Verdict |
|---|---|---|---|
| SWE-bench Verified | 61% | 64% | Looks like an upgrade |
| Demo build (T1) | works | works | Looks fine |
| **Harness success rate (T2)** | 88% | 74% | **Regression** |
| **Harness success rate (T3)** | 71% | 52% | **Regression** |
| **Mean iteration count (T2)** | 3.1 | 5.8 | **Worse** |
| **Cost per successful deploy** | $0.42 | $0.61 | **Worse despite cheaper tokens** |

The cheaper model is *worse per shipped app* because it needs nearly twice the iterations and fails more multi-user/payment builds — exactly the multi-step reasoning that de-refined or smaller models regress on (see the abliteration caveat in `03-model-layer-and-serving.md`). SWE-bench went up; the product got worse. **The gate (Section 5.2) blocks this merge**, which is the entire point: the external benchmark and the demo both lied, and only the internal KPIs told the truth.

**Rule:** a higher external benchmark score is *never* sufficient justification to ship a model change. The internal harness KPIs are the deciding vote.

---

### 6. Anti-patterns (don't do this)

- **Don't** run the browser or any verification code in the control plane. It renders untrusted app code.
- **Don't** show "done" on unverified output. A green typecheck is not a working app.
- **Don't** let the agent respond to a test failure with a full-file rewrite. Localize and diff.
- **Don't** benchmark models on token price or SWE-bench score alone. Decide on cost-per-successful-deploy from your own harness.
- **Don't** edit an eval oracle to make a regression disappear. Fix the platform or record the regression.
- **Don't** verify against mocks and call it green. Round-trip real data.
- **Don't** loop forever. Cap iterations and escalate to a human gate.

---

### 7. Cross-references

- `00-blueprint.md` — master; §2 bet 2 (verification is the moat).
- `01-architecture-blueprint.md` — plane separation; diff/AST edits over rewrites.
- `02-sandbox-and-isolation.md` — where all verification executes.
- `03-model-layer-and-serving.md` — model routing, serving; source of the models the harness grades.
- `04-orchestration-and-agent-loop.md` — the loop that consumes verification feedback; iteration caps.
- `06-control-plane-and-deployment.md` — authenticated preview proxy the browser tests hit; checkpoints for reproducing runs.
- `07-operations-runbook.md` — cost-per-successful-deploy dashboards; model rollout/rollback.
- `08-security-and-abuse-playbook.md` — prompt injection via content the verifier reads.
- `09-execution-roadmap.md` — when each verification layer and the harness come online.
