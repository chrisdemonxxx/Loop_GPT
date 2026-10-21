# 04 — Orchestration and the Agent Loop

**Purpose.** This is where most of your engineering effort actually goes. This doc specifies the harness — Layer 2 of `01-architecture-blueprint.md` — that turns a model into a builder: the durable workflow engine, the planner → task-DAG decomposition, the tool-calling loop, diff/patch editing over full-file rewrites, context management (two-stage retrieval + condensation), parallel task agents on copy-on-write forks with merge gating, human-in-the-loop confirmation gates, and failure/retry semantics. The orchestrator lives entirely in the **control plane**; the code it produces runs **only** in the data-plane sandbox (`02-sandbox-and-isolation.md`). The model is the engine; this is the car.

---

### 0. Where this sits

Natural language → structured plan → code/infra changes **in a sandbox** → run + observe + test → iterate → deploy. The orchestrator owns every stage of that loop *except* actual execution, which it delegates over a signed, least-privilege RPC channel to a leased sandbox (`01`, `02`). It calls models only through the control-plane router (`03`). It never executes agent-generated code itself — that would put generated code in the control plane, the one rule that shapes everything (`01`).

---

### 1. Durable workflow engine

Agent runs are long — minutes to hours — and **must survive process restarts**. A crash must resume, not lose an hour of work.

- **Use a durable workflow engine (Temporal-style).** A Run is a durable workflow instance (`01` data model). Its state — plan, task-DAG progress, tool results, gate decisions — is persisted, so a worker crash resumes from the last committed step.
- **Retries are principled, not ad hoc.** The engine's retry policy handles transient failures (Section 8) with backoff and caps, instead of scattered try/catch.
- **Human-in-the-loop gates are first-class** (Section 7): the workflow can *durably pause* awaiting an approval signal for hours without holding a process or a sandbox lease open.
- **Every step is an audited event** (`07`, `08`): the workflow history *is* your trace.

> API details of any specific engine are time-sensitive — verify current APIs at build time. The *requirement* (durability, resumable, first-class signals/timers) is stable.

**Do this:** model the run as a durable workflow; keep sandbox execution as activities with their own timeouts. **Don't do this:** hold agent state in process memory or a single request handler — the first restart loses everything.

---

### 2. Planner → task DAG

The planner decomposes a request into a **directed acyclic graph of tasks**, not a flat list. The DAG expresses dependencies (task B needs task A's output) and parallelism (tasks C and D are independent).

- Planner input: the request + project context via two-stage retrieval (Section 4). Planner output: a **task DAG**, generated with **structured outputs** (`03`) so it validates against the DAG schema.
- Each task node carries: goal, dependencies (`dag_parents`), the checkpoint it forks from, an expected verification, and a **destructiveness flag** (does it delete data, deploy, spend, or write externally? → confirmation gate, Section 7).
- Independent nodes fan out to **parallel task agents on CoW forks** (Section 5). Dependent nodes run in order, each starting from the predecessor's green checkpoint.
- Re-planning: when verification failures (`05`) invalidate assumptions, the planner revises the *remaining* DAG rather than restarting — the durable workflow makes partial progress cheap to keep.

**Opinionation helps the planner.** With one supported stack (`06`, `09`), the planner's task vocabulary is small and reliable ("add a table + RLS", "add a route", "wire auth") instead of open-ended. A narrow, deeply-supported stack produces far higher success rates than a general planner that can theoretically do anything and reliably does nothing.

---

### 3. The tool-calling loop

Each task agent runs a ReAct/CodeAct loop: **think → act (tool call) → observe → repeat** until the task's verification passes or a budget/retry limit trips (Section 8).

#### Tools (least-privilege, one job each)

| Tool | Does | Guardrail |
|---|---|---|
| `read_file` / `search_code` | Read project context | Read-only; scoped to the project fork |
| `apply_patch` | Apply a **diff/patch** (Section 6) | Validated against the file; rejects malformed hunks |
| `run_shell` | Run build/test/install in the sandbox | Data plane only; egress-allowlisted (`02`) |
| `browser` | Playwright verification (`05`) | Inside the sandbox |
| `provision` | DB schema/auth/storage/RLS (`06`) | Safe-by-default templates; RLS on by default |
| `deploy` | Explicit deploy (`06`) | **Always** behind a confirmation gate (Section 7) |

#### Loop discipline

- **Tool calls use structured outputs** (`03`) constrained to each tool's schema, validated on receipt. Never free-form-parse a tool call.
- **All tool output is untrusted data**, never instructions (`02` §8, OWASP GenAI 2026 Prompt Injection). A fetched README or a test log cannot steer the agent's permissions.
- **CodeAct** (agent emits executable code rather than rigid JSON tool calls) buys flexibility for complex multi-step actions but **needs tighter sandboxing** — it only ever runs in the data plane, under the same caps and egress rules (`02`).
- **Never let tool output silently escalate permissions** (OWASP GenAI 2026 Excessive Agency). Escalation requires a human gate.

---

### 4. Context management

Long sessions overflow any context window; naive "stuff everything in" both breaks and costs more. Two techniques carry the load.

#### Two-stage retrieval

1. **Stage 1 — coarse locate.** Cheap retrieval (symbol/index/keyword or embedding search over the file index) narrows thousands of files to a handful of candidates.
2. **Stage 2 — focused read.** Read the specific candidate files/spans into context for the actual edit.

This keeps the prompt small and, because the stable harness prefix stays byte-stable and first, preserves prefix-cache hits (`03` §3). **Do this:** put retrieved code *after* the stable system prompt. **Don't do this:** paste whole repos into context — it defeats the cache and buries the signal.

#### Condensation

For long autonomous runs, **condense** older turns: summarize resolved sub-tasks and their outcomes into compact notes, keeping the active task's detail in full. The durable workflow retains the full history for audit (`07`) even after the *prompt* is condensed. Condense on a token-budget threshold, not every turn.

---

### 5. Parallel task agents on CoW forks + merge gating

Independent DAG nodes (Section 2) run concurrently, each in its **own sandbox on a copy-on-write fork** of the same green checkpoint (`02` §4). This is why Replit-style task agents run on *forked* project state — CoW is what makes parallelism and rollback affordable (`01`, `02`).

```
                       green Checkpoint C_n
                      /         |          \
           CoW fork A     CoW fork B     CoW fork C
          (task agent)   (task agent)   (task agent)
                \             |             /
                 \            |            /
                  ▼           ▼           ▼
             ┌───────── MERGE GATE ─────────┐
             │ verification sub-agent (05):  │
             │  typecheck→tests→browser      │
             │  merge only if green + no     │
             │  conflicting writes           │
             └──────────────┬────────────────┘
                            ▼
                   new green Checkpoint C_{n+1}
```

#### Merge gate rules

- A fork's changes merge **only** after a **verification sub-agent** passes them (`05`): typecheck/lint → tests → browser smoke test.
- **Detect conflicting writes** across forks; on conflict, serialize (re-run the losing fork on the winner's post-merge checkpoint) rather than blindly three-way merging generated code.
- Merge produces a **new green checkpoint**; nothing merges into a non-green base.
- **Gate:** two independent features build in parallel and merge without clobbering each other (`09` Phase 3 gate).

**Do this:** isolate each parallel agent on its own CoW fork + gate the merge on verification. **Don't do this:** let parallel agents write the same working tree — that is the classic parallel-clobber bug.

---

### 6. Diff/patch editing over full-file rewrites

**Prefer diff/patch application (or AST-aware edits) over full-file rewrites.** Full-file rewrites are the number-one cause of silent regressions in these systems — the model "helpfully" drops or alters code it wasn't asked to touch.

| | Diff/patch (do this) | Full-file rewrite (avoid) |
|---|---|---|
| Blast radius | Only the changed hunks | Entire file, including untouched code |
| Regression risk | Low; unchanged code is literally unchanged | High; silent drops/alterations |
| Reviewability | Human/gate sees exactly what changed | Must diff the whole file to see intent |
| Token cost | Small | Large (re-emits the whole file) |

- The `apply_patch` tool takes a structured diff, validates each hunk against the current file, and **rejects** if context doesn't match (stale-read protection) — forcing a re-read rather than a blind overwrite.
- For structural edits (rename a symbol across files), prefer AST-aware transforms over textual diffs where the toolchain supports it.
- **Exception:** creating a brand-new file is a "rewrite" trivially; that's fine. The rule is about *editing existing* files.

---

### 7. Human-in-the-loop confirmation gates

Autonomy vs. control is a slider, not a binary. Even hands-off runs must gate the irreversible.

- **Gate on destructive/irreversible actions:** delete data, drop/alter production schema, deploy, spend money, write to external systems, rotate secrets. These carry the destructiveness flag from the DAG (Section 2).
- The durable workflow **pauses** on a gate awaiting an approval signal (Section 1) — no held process, no held sandbox lease. It can wait hours.
- Gates are also the **structural answer to prompt injection / Excessive Agency** (`02` §8, OWASP GenAI 2026): injection can make the model *want* to deploy or delete; the gate means it can't without a human.
- **Auto-approve policy** is allowed for clearly-reversible actions (a file edit inside a fork you can roll back via checkpoint) to keep flow; **never** auto-approve the irreversible set above.

**Do this:** classify each action's reversibility and gate the irreversible. **Don't do this:** gate everything (users revolt) or gate nothing (one injected instruction deploys attacker code).

---

### 8. Failure and retry semantics

Failures are the normal case in an agent loop; handle them as a first-class control flow, driven by the durable engine (Section 1).

| Failure type | Handling |
|---|---|
| **Transient** (sandbox provision hiccup, model timeout, registry blip) | Engine retry with backoff, bounded attempts; router falls back to same-class model (`03`). |
| **Verification failure** (typecheck/test/browser red — `05`) | The observation feeds the loop as the next planning input (reflection). Retry the task; after N attempts, re-plan (Section 2). |
| **Budget exceeded** (iterations, tokens, wall-clock, credits) | Stop the task, surface an explicit status, request human input. Never loop forever. Track cost per successful deploy (`07`). |
| **Merge conflict** (Section 5) | Serialize the losing fork onto the winner's checkpoint and re-run. |
| **Gate rejected** (Section 7) | Halt that branch; record decision; await revised instruction. |
| **Hard error** (sandbox escape attempt, kill-switch trip — `02` §6) | Kill the sandbox, flag the tenant for abuse review (`08`), fail the run explicitly. |

#### The reflection loop is the point

A failed verification is not an error to swallow — it is the **next input**. "Button X threw 500", "page Y blank, console shows undefined" becomes the planner's next task. This reflection loop is what converts a plausible-looking app into a working one and is inseparable from the verification investment in `05`.

**Do this:** bound every loop (iterations, tokens, time, credits) and feed failures back as observations. **Don't do this:** retry indefinitely on the same failing approach — cap it and re-plan.

---

### 9. Orchestration checklist

- [ ] Runs are durable workflows: resumable across restarts, principled retries, first-class pause-for-approval.
- [ ] Planner emits a validated **task DAG** (structured outputs), with dependencies, fork points, and destructiveness flags.
- [ ] Tool-calling loop uses least-privilege tools, one job each, constrained + validated tool calls.
- [ ] All tool/fetched output treated as untrusted data (OWASP GenAI 2026 Prompt Injection).
- [ ] Two-stage retrieval + condensation keep context small and prefix-cache-friendly (`03`).
- [ ] Parallel task agents run on CoW forks; merges gated by a verification sub-agent; conflicts serialized.
- [ ] Edits are diff/patch or AST-aware; full-file rewrites avoided for existing files.
- [ ] Confirmation gates on all destructive/irreversible actions (deploy, delete, spend, external write); reversible actions may auto-approve.
- [ ] Every loop is bounded (iterations/tokens/time/credits); failures feed back as observations (reflection).
- [ ] Generated code runs only in the data-plane sandbox; the orchestrator never executes it (`01`, `02`).

Get orchestration and verification (`05`) right and the platform feels magical; get them wrong and the best model in the world still ships broken apps.
