# 00 — The Blueprint: Open, Self-Hosted AI Software-Building Platform

**Prepared:** August 17, 2026 · **Verified against primary sources:** Aug 17, 2026
**Companion to:** `research/unrestricted-ai-builder-playbook.md` (the condensed master playbook)

This is the master index and executive blueprint for building a Replit/Lovable-class agentic app-building platform on open-weight, self-hosted models — with full code ownership and no vendor model policy. Read this document first; each section links to the deep-dive doc that owns it.

---

### 1. The one-page thesis

These platforms are **agent harnesses, not single LLM calls**: an orchestration loop wrapping models with tools, memory, a sandboxed runtime, a verification feedback loop, and an explicit deployment boundary, running the cycle:

**Natural language → structured plan → code changes in a sandbox → run + observe + test → iterate → deploy.**

"Unrestricted" decomposes into four dimensions — three you build aggressively, one you refuse:

| Dimension | Verdict |
|---|---|
| Open model choice (any open-weight model, incl. low-refusal fine-tunes, on your GPUs) | \textbf{Yes} The real product |
| Product openness (user owns code, Git export, self-hostable) | \textbf{Yes} The differentiator |
| Capability breadth (full Linux, real packages, real browser, real deploys) | \textbf{Yes} Table stakes |
| Removing isolation / tenant separation / egress control / abuse detection | \textbf{No} Never. An uncensored **model layer** sits on a hardened **execution layer** — orthogonal by design. |

The cardinal rule everywhere: **agent-generated code executes only in the data plane, never in the control plane.**

### 2. The three bets that decide success

1. **Opinionation is a feature.** One deeply supported stack beats a general agent. (Docs 01, 09)
2. **Verification is the moat.** The platform runs and clicks through the app before showing the user; failures feed back into planning. Track cost-per-successful-deploy, not benchmark scores. (Doc 05)
3. **Isolation is what makes openness viable.** Firecracker-class microVMs (<125 ms boot, <5 MiB overhead — verified), default-deny egress, metadata-endpoint block, no ambient credentials. This is what lets you say yes to any model. (Docs 02, 08)

### 3. Documentation map

| Doc | Owns | Read when |
|---|---|---|
| [01 – Architecture Blueprint](01-architecture-blueprint.md) | Four planes, eight layers, trust boundaries, data flows, data model | Designing the system |
| [02 – Sandbox & Isolation](02-sandbox-and-isolation.md) | Isolation ladder, sandbox lifecycle, egress control, CoW checkpoints, threat classes | Building the data plane |
| [03 – Model Layer & Serving](03-model-layer-and-serving.md) | vLLM-first serving (TGI is EOL-maintenance since Dec 2025), router, GPU economics, low-refusal model protocol, licensing | Standing up inference |
| [04 – Orchestration & Agent Loop](04-orchestration-and-agent-loop.md) | Durable workflows, planner/task-DAG, diff-based editing, context management, parallel agents | Building the harness |
| [05 – Verification & Evals](05-verification-and-evals.md) | Layered checks, browser smoke loop, internal eval harness, the four KPIs | Making it reliable |
| [06 – Control Plane & Deployment](06-control-plane-and-deployment.md) | SaaS scaffolding, secrets discipline, previews, deploy options, RLS-by-default | Building the product around the agent |
| [07 – Operations Runbook](07-operations-runbook.md) | Incident runbooks, warm pools, cost dashboards, rollout/rollback | Running it in production |
| [08 – Security & Abuse Playbook](08-security-and-abuse-playbook.md) | Abuse taxonomy + detection, red-team plan, SAST on output, audit | Before and after launch |
| [09 – Execution Roadmap](09-execution-roadmap.md) | Phases 0–5 with gates, budgets, build-vs-buy, risk register | Planning the build |
| [10 – Governance, Legal & Policy](10-governance-legal-policy.md) | Content-vs-abuse policy split, AUP, licenses, processor ToS, data handling | Before taking money |

### 4. Verified facts this suite relies on (Aug 17, 2026)

- **Firecracker:** <125 ms boot, <5 MiB memory overhead per microVM, up to 150 microVMs/s per host (official project figures).
- **TGI entered maintenance mode Dec 11, 2025**; Hugging Face recommends **vLLM or SGLang**. vLLM ships automatic prefix caching and structured outputs.
- **Qwen3-Coder** (July 22, 2025): real open-weight agentic coding family — the "strong open coding model" premise holds.
- **SWE-bench Verified:** human-validated 500-problem subset; measures repo issue-fixing, a weak proxy for shipped apps.
- **OWASP GenAI LLM Top 10:** current release is the **2026** list; Prompt Injection and Excessive Agency are the key agentic risks.

Time-sensitive items (GPU pricing, individual model licenses, list editions) must be re-checked before commercial commitments.

### 5. Start-here decision checklist

1. Commit to **one opinionated stack** (doc 01 §stack, doc 09 Phase 2).
2. Pick the isolation runtime — **microVM strongly preferred** — and enforce default-deny egress + metadata block from day one (doc 02).
3. Stand up the **model router early**; models must be swappable (doc 03).
4. Build the **internal eval harness before scaling**; optimize cost-per-successful-deploy (doc 05).
5. Invest in the **browser-verification loop** — the differentiator (doc 05).
6. Separate the **four planes**; generated code never leaves the data plane (docs 01, 02).
7. Keep **model-content policy separate from infrastructure-abuse policy** (doc 10) — this is what makes "open model layer" durable.
8. Run the **red-team gate** before any public launch (doc 08).
