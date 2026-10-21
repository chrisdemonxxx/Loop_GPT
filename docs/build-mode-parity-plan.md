# Build Mode parity plan: Replit Agent / Lovable / Bolt.new / v0

Status: execution wrap-up, 2026-10-20. Originally a planning document; Phase 0–3 product
code paths are now implemented offline-first. Live/cloud seams are documented in
`deploy/loopit/ENV.md` (see **Execution status** below and **Remaining live/cloud gaps**).
Scope: the `/build` experience in `apps/web`, its parent-API seams in `backend/`, and the
Loop-IT engine in the nested `Loop-it/` repository (separate git history, deployed per
`deploy/loopit/`).

### Execution status (2026-10-20)

Phase 0–3 code paths ship **offline-first**: local `RunManager`, memory/fake providers,
static preview, and sidecar stores work without Temporal Cloud, E2B, Neon, GitHub App,
or ACME credentials. Orchestrator, sandbox shell, HMR, hosting, provision, gitsync,
domains, browser tests, and related APIs are wired in compose and product UI; turning
them **live** requires the env seams in `deploy/loopit/ENV.md` (and the gaps listed in
§7). Do not treat offline stubs as production parity for sandbox runtime, true PTY,
Neon/`pg_dump`, GitHub App tokens, ACME TLS, or edge analytics.

---

## 1. Executive summary

Build Mode exists end to end. A user types a prompt on `/build`. Loop-GPT mints a
short-lived `LOOPIT-ID` token, and nginx forwards `/api/loopit/*` to the Loop-IT FastAPI
service. Default deploy mode remains **local**: one agent loop per run on a thread, with
durable file checkpoints, credit metering seams, immutable publish, projects UI, Plan/Chat
modes, diffs, and Phase 2–3 surfaces (GitHub/domains stubs, visual edit, security scan,
Monaco, effort switch, etc.).

The **default offline path** still scaffolds a no-build static React/htm site (esm.sh
import map) with a parse-first verifier. Full-stack templates (`vite-react`,
`react-postgres`), sandbox tools, HMR preview-proxy, and Temporal/E2B orchestration are
implemented in code and compose but need live credentials to leave the memory/fake path.

The UI is shaped like Replit and Lovable: chat with streaming and steering, task/progress,
versions with rollback, fork/publish/share, multi-device preview, projects/templates,
Monaco editor, and an admin-gated terminal.

What still blocks production parity (not “unwired libraries,” but **live seams**):

1. **Live runtime.** Temporal Cloud + E2B (and dispatch `CommandRunner` into verify) are
   not on by default; local mode still refuses agent shell.
2. **True sandbox PTY / nginx `/p/` HMR edge.** Interactive byte-stream PTY and prod path
   fronting for preview-proxy remain gaps.
3. **Managed data & TLS.** Neon/`pg_dump`, GitHub App install tokens, ACME/Cloudflare for
   SaaS, vision model routing, Plan DAG on Temporal, edge analytics.
4. **Ops.** Pause/resume HTTP, sandbox `HTTP_PROXY` → egress, registrar purchase UI.

The fastest route to live parity remains **activate credentials and finish the seams**,
not rebuild the platform.

---

## 2. Is the uncommitted work part of Build Mode?

No. The untracked and modified files are a **local developer-automation "bot fleet"**, not
the product's Build Mode:

| Path | What it is |
| --- | --- |
| `opencode.json` | OpenCode CLI config: agents `grok`, `researcher`, `operator`, `builder`; Playwright MCP |
| `.opencode/agents/builder.md` | Prompt for an OpenCode *coding sub-agent* ("Builder bot") used on this repo |
| `.opencode/commands/dispatch.md`, `.opencode/skills/*` | Dispatch command plus memory and teach-task skills |
| `.bots/**` | Per-bot `MEMORY.md`, job and ops logs, and a browser recording (`rec-mvgshgzg`) |
| `bot-console/server.mjs` (351 lines), `bot-console/public/index.html` | Local SSE console at `:4319` that spawns `opencode.exe` sessions per bot |
| `scripts/run-bot.ps1` | Scheduler for those bots (Windows Task Scheduler, mutexed logs) |
| `package.json` | Adds only `"console": "node bot-console/server.mjs"` |

None of these files touch `/build`, `backend/src/routes/buildV1.ts`, `packages/loopit-client`
or `Loop-it/`. The "builder" naming is a coincidence. It is out of scope here, apart from one
idea: the bot console's "teach-a-task" recording is a possible later input for agent
self-testing.

---

## 3. How Build Mode works today

Baseline topology and local-mode behaviour (still the default compose path). Phase 0–3
additions (durable checkpoints, projects UI, orchestrator profile, etc.) are summarized
in §7; this section remains the forensic “control plane + local RunManager” map.

### 3.1 Topology

```
Browser (/build, static Next export)
  │  POST /api/loopit/token  (cookie session) ───────────► backend (Express) routes/loopit.ts:71-116 → LOOPIT-ID JWT
  │  /api/loopit/*  (Bearer LOOPIT-ID)  ── nginx web/nginx.template.conf:182-199 ──► Loop-IT api (FastAPI) /api/*
  │  /api/loopit/projects/<id>/site/... ── nginx :137-158 ──────────────────────────► same api (preview + "deploy" files)
  │
Loop-IT api (Loop-it/apps/api) — LOOPIT_RUN_EXECUTION_MODE=local (deploy/loopit/docker-compose.yml:121)
  └─ RunManager thread per run (runs.py:876-951) → AgentLoop (packages/agent-core/loop.py)
       └─ model: HF router via live_model_factory (app.py:265-312)
       └─ tools: Workspace read/search/apply_patch on disk; run_shell always refuses (workspace.py:190-224)
       └─ verify: PreviewVerifier (static parse/reference checks, runs.py:289-572)
```

The compose stack also starts `router-svc`, `scheduler` (E2B) and `preview-proxy`, but in
local mode the API does not use them: its model factory calls the HF router directly, and
local runs never lease a sandbox. The orchestrator, `workspace-dispatch`, `loopit-mcp`,
deployer and domains services are **not** in the stack (`deploy/loopit/README.md:10-27`,
`docker-compose.yml`).

### 3.2 UI entry points

- **Nav:** the Build link appears only when the web app is built with `LOOPIT_ENABLED=1`
  (`apps/web/next.config.js:2-26`, `apps/web/app/components/chat/Sidebar.tsx:17,182`).
  `/code` redirects to `/build` under the same flag.
- **Board:** `apps/web/app/build/page.tsx:34-134` has a prompt box, three sample chips and a
  run list. It polls every 4 seconds while any run is live (`hooks.ts:29-42`).
- **Run view:** `/build/?run=<id>` renders `RunView`. Static export forces a query param, with
  `[runId]/page.tsx` emitting only `_` (`app/build/[runId]/page.tsx:1-14`).
- **From chat:** the `mcp__loopit__start_run` built-in tool (`backend/src/agent/mcp/loopitBuiltin.ts:26-41`)
  starts a run from a conversation and links `/build/?run=`. It needs `LOOPIT_MCP_URL`, and
  `loopit-mcp` is not deployed.
- **Public API:** `POST/GET /v1/build/runs` (`backend/src/routes/buildV1.ts`, mounted at
  `backend/src/server.ts:199`).
- **Mobile:** `mobile/src/screens/Build.tsx:5-30` just opens the web `/build` page.

### 3.3 Prompting and orchestration

1. `POST /api/runs` (`app.py:666-742`) runs a preflight credit check with a fixed estimate of
   `0.01` (`:672-682`), then calls `RunManager.start` (`runs.py:876-951`).
2. **New project:** the React scaffold (`index.html`, `main.js`, `App.js`, `styles.css`) is
   written (`stacks.py:109-114`) and snapshotted as a verified "initial scaffold" checkpoint
   (`runs.py:897-911`).
3. **Brief ("prompt elasticity"):** one planner call returns `{title, summary, expanded_prompt,
   complexity}`. Complexity sets the iteration budget: quick=8, standard=14, deep=24, max=40
   (`brief.py:46-51, 170-205`). Any failure falls back to the raw prompt (`brief.py:153-167`).
4. **Loop:** `AgentLoop` uses `SYSTEM_PROMPT` plus `REACT_GUIDANCE` (`runs.py:230-286`,
   `stacks.py:131-187`). The goal text puts the user's words first as binding, then the capped
   brief notes, then the file listing (`runs.py:1340-1365`). The model emits one JSON tool call
   per turn. Steering messages are drained from an inbox each iteration (`runs.py:1062-1068`).
   Cancel is checked at iteration boundaries. Context is summarized past 50K tokens
   (`runs.py:1094-1098`).
5. **Plan/DAG:** always a hard-coded **single node** `build-preview` (`runs.py:1218-1239`).
   There is no real planning and no user-approvable plan.
6. **Verification:** `PreviewVerifier` (`runs.py:289-572`) runs only after a patch has been
   applied and the agent then reads. It checks JS/JSON/Python parse, dangling `src`/`href`
   and imports, unreachable modules, unstyled class names, JSX in `.js` files, and string
   `style` props. Nothing executes and no browser renders the page.
7. **Finish:** the run gets one checkpoint (`runs.py:1117-1124`), verified only if the run
   ended verified, and the persisted run record is finished (`app.py:406-411`, `persist.py:98-108`).

### 3.4 File generation and editing

- The only write path is unified diff through `loopit_patch` (`workspace.py:156-188`).
  Invariant I6 forbids full-file rewrites.
- Paths are confined to the workspace with symlink-safe resolution (`workspace.py:50-66`).
- Diffs reach the UI only as raw JSON tool calls inside assistant chat bubbles, expandable to
  the patch text (`RunView.tsx:717-757`). There is no diff viewer, no per-file change list and
  no accept or reject.
- Token streaming: `chat_chunk` events render as a monospace streaming bubble
  (`RunView.tsx:108-111, 881-888`).

### 3.5 Running and previewing

- `POST /api/projects/{id}/preview` mints a 900-second signed token (`app.py:1042-1071`). The
  iframe loads `/api/loopit/projects/<id>/site/t/<token>/<path>` with `sandbox="allow-scripts"`
  (`RunView.tsx:42, 697-705`).
- Files are served with a strict CSP: `connect-src 'none'`, scripts only from self and esm.sh
  (`app.py:1148-1203`). **Allowed types are text only:** `.html .css .js .mjs .json .svg .txt .md`
  (`app.py:141-155`). Everything else is sent as `text/plain`, and `Workspace.read` decodes
  text with `errors="replace"` (`workspace.py:104-108`).
- "Hot reload" is a full iframe remount, debounced 1.5 seconds after `run` events or
  successful tool calls (`RunView.tsx:92-97, 127-135`).
- Devices: desktop, or a mobile width capped at 390 px (`RunView.tsx:611, 658-675, 688`).
- **Terminal:** `POST /api/projects/{id}/exec` runs `subprocess.run(command, shell=True,
  cwd=project)` **on the API host** (`terminal.py:31-88`, `app.py:1023-1040`). Health still
  reports `exec_enabled: False` (`app.py:533`).

### 3.6 Error handling and retry

- An engine crash sets status `error`, `budget_exceeded`, `stalled` or `cancelled`, with
  friendly summaries (`runs.py:1130-1161, 1283-1315`).
- UI: Stop, Continue (which only focuses the composer), Retry (which starts a new run with the
  same prompt) and Resend (which starts a new run from any earlier user message)
  (`RunView.tsx:243-264, 196-207, 760-780`).
- Stream reconnects up to 4 times on failure (`hooks.ts:141-169`). Events are de-duplicated by
  `_seq` (`RunView.tsx:99-106`).
- Recovery inside the loop is driven by verifier failures and patch-mismatch observations.
  There is no runtime error capture: the preview's console errors never reach the agent.

### 3.7 Versions, persistence and publishing

- **Checkpoints:** `CheckpointStore(InMemoryBlobStore())` (`runs.py:784`) holds all versions
  in RAM. Rollback rewrites workspace files (`runs.py:842-849, 1192-1204`). Fork copies to a
  new project id (`runs.py:851-873`).
- **Runs:** live state is in memory (`runs.py:777-783`). The catalog goes to Postgres when
  `LOOPIT_STORE_DSN` is set (`app.py:386-405`), but `record_to_dict` drops title, files, DAG
  and checkpoints (`persist.py:35-57`). The SSE journal is written to
  `<projects>/.runs/<run>.jsonl` (`runs.py:690-738`). Workspace files live on the
  `loopit-projects` volume.
- **Publish:** requires a verified checkpoint. It mints a 30-day signed URL to `index.html`
  and appends a record to `.deploys/<project>.json` (`app.py:1088-1146`). There is no build
  step, no immutable artifact and no custom domain.

---

## 4. Functional bugs and incomplete pieces

Severity uses the same P0/P1/P2 scale as the roadmap. "Confirmed" means verified by reading
the code path. Historical note: early 2026-10-20 baseline had clean `tsc` / 35 vitest build
tests / 152 pytest. After parallel Phase 1–3 merges, treat §7 status blocks as authoritative;
re-run tests before a live launch. P0/P1 rows below are retained as forensic evidence of
pre-fix behaviour.

### P0: broken, insecure or data-losing

**Status (2026-10-20): B1–B8 are fixed (Phase 0 Done).** See "Phase 0 status" in §7. The
line references below describe the code before the fixes.

| # | Bug | Evidence |
| --- | --- | --- |
| B1 | **Published links serve the live workspace, not the published checkpoint.** Any later edit, failed run or rollback silently changes the "live" app. | `app.py:1113-1129` mints a token for the project. `_serve_project_file` reads `manager.project(...)` workspace files (`app.py:1148-1157`). `checkpoint_id` is stored but never used to serve. |
| B2 | **Everything project-scoped breaks after an API restart.** `_projects`, `_workspaces` and `_runs` are in memory, so `project_tenant()` returns `None`. Preview, exec, checkpoints, rollback, fork, deploy and **published sites** all return 404. | `runs.py:777-783, 822-829`. `app.py:954-956, 1029-1031, 1048-1050, 1096-1098, 1149-1151` |
| B3 | **All checkpoints are lost on restart.** Users lose version history and cannot publish older work. | `runs.py:784` `InMemoryBlobStore()` |
| B4 | **User terminal is remote code execution on the shared control plane.** `shell=True` in the API container with the tenant's project as cwd. It can read env secrets (`LOOPIT_IDENTITY_SECRET`, `HF_TOKEN`, DB DSN) and other tenants' project folders on the shared volume. Health claims exec is disabled. | `terminal.py:47-55`. `app.py:1023-1040, 533`. Violates the project's own invariant I1 (`Loop-it/PLAN.md`). |
| B5 | **Retry and Resend do not keep the project.** They send only `{prompt}`, so a brand-new project is created and edits are lost. The comments promise "same project". | `RunView.tsx:196-207, 760-780`. `hooks.ts:55-63` (the mutation only accepts `prompt`, while `startRun` supports `projectId` at `packages/loopit-client/src/api.ts:182-194`) |
| B6 | **Switching runs inside `/build` keeps stale state and drops the new run's events.** `RunView` is not keyed by `runId`, so `seenSeqRef` keeps the old run's `_seq` numbers. The new run's journal also starts at 1, so its events are discarded. Messages, UI state and preview path also leak across runs. | `page.tsx:28-32` (no `key`). `RunView.tsx:60-73, 99-106`. `runs.py:713-722` |
| B7 | **Builds are not billed to Loop-GPT credits.** The engine never calls `/api/loopit/usage` (or `/context`). Each identity-bridge org gets 2.0 internal credits. The preflight estimate is a fixed 0.01, and the per-run cap defaults to 500. | `backend/src/routes/loopit.ts:198-244` (unused by the engine). `app.py:486-497, 672-682, 288` |
| B8 | **Public `/v1/build` API always 404s upstream.** It proxies to `${LOOPIT_API_URL}/v1/runs`, but the engine serves `/api/runs`. `model` and `org_id` in the body are ignored by the engine. | `backend/src/routes/buildV1.ts:61, 103`. `app.py:666, 759` |

### P1: user-visible defects and dead flows

| # | Bug | Evidence |
| --- | --- | --- |
| B9 | Approval gates cannot resume a local run. In local mode, approve and reject only write an audit row; nothing signals the loop. Local runs never create gates anyway. Dead UI. | `app.py:820-859` (signal only in orchestrator mode) |
| B10 | Orchestrator mode is half-wired. `get_run` returns `files: []`, `dag: None`, `checkpoints: []`. Messages, cancel, exec, preview, checkpoints and file reads go only to the local `RunManager`, so they 404. `temporal_runs` is in memory. `build_default_app` defaults to orchestrator while the deployed compose forces local. | `app.py:700-724, 763-767, 902-929, 1414-1431` |
| B11 | Preview breaks after 15 minutes. The signed URL TTL is 900 s, and `usePreviewUrl` has no refetch interval, so the next epoch reload of the iframe returns 401. | `app.py:1052`. `hooks.ts:121-128` |
| B12 | Binary assets cannot work. PNG, JPG, fonts and other non-text files are served as `text/plain`, and reads use text decoding with replacement. An uploaded or generated image would be corrupted. | `app.py:141-155, 1158-1163`. `workspace.py:104-108` |
| B13 | "Save a copy" (fork) creates an unreachable project. The result's `project_id` is ignored, the toast says "Version saved", and there is no projects UI to open it. | `RunView.tsx:157-170`. `hooks.ts:101` |
| B14 | Rollback does not refresh the preview or the file list (no epoch bump). The restore also lands while a live run may still be writing the same workspace, with no lock. | `RunView.tsx:157-170`. `runs.py:842-849` |
| B15 | Terminal errors are swallowed: `exec.mutate` has no `onError`, so a 404 or 503 shows nothing. | `RunView.tsx:932-945` |
| B16 | Persisted runs after restart lose title, files, DAG and checkpoints, and show the raw prompt and an empty preview. | `persist.py:35-57`. `app.py:768-773` |
| B17 | A stream that ends cleanly while the run is still live (for example a proxy idle cut) is never reopened: the retry loop only handles thrown errors. One malformed SSE `data:` line throws inside `JSON.parse` and kills the stream. | `hooks.ts:150-161`. `packages/loopit-client/src/api.ts:345-350` |
| B18 | The preview only works for `.html` paths. Picking a JS or CSS file opens the code drawer, and a project without `index.html` never previews. | `RunView.tsx:146, 346-349` |
| B19 | "Continue" only focuses the composer, but sending a message to a finished run returns 409 ("run is not active"). There is no continue-as-new-run path. | `RunView.tsx:255-261`. `app.py:911-915` |
| B20 | **Done (compose).** `loopit-mcp` is in `deploy/loopit/docker-compose.yml`; set Loop-GPT `LOOPIT_MCP_URL` to its public https origin so chat `start_run` appears. | Was: not in compose. Now: `deploy/loopit/docker-compose.yml` + `ENV.md` |

### P2: polish and debt

- B21: the file listing in the goal is built from a **set**, so its order changes between runs (`runs.py:1362`).
- B22: `confirm.tsx:33` has a `react-hooks/exhaustive-deps` warning.
- B23: `deploy/loopit/README.md:94` still says "The `/build` page is a placeholder". This is stale.
- B24: the activity icon is chosen by regex over English text (`RunView.tsx:534-543`). It is fragile.
- B25: the code view is plain `<pre>`. There is no syntax highlighting, editing, tree or search (`RunView.tsx:992-1012`).
- B26: the board marketing copy promises "publishes with one click", but publishing is only a signed link (`page.tsx:86`).
- B27: there are no `RunView` component tests or end-to-end tests for `/build`.

---

## 5. Feature-by-feature comparison

The reference behaviour comes from current vendor documentation (Replit docs: Plan Mode,
Checkpoints, App Testing, dev/prod databases. Lovable docs and changelog through 2026-09:
Chat/Plan mode, visual edits, Lovable Cloud, two-way GitHub sync, custom domains, remix,
security scans. Bolt.new FAQ: WebContainers. Vercel v0: Next.js, shadcn, Vercel deploy).

Status key: ✅ parity · 🟡 partial · ❌ missing.

| Capability | Replit Agent | Lovable (Bolt / v0) | Loop Build (2026-10-20) | Status |
| --- | --- | --- | --- | --- |
| Prompt-to-app scaffolding | Full-stack app; picks stack; DB provisioned | React + Vite + Tailwind + shadcn, Supabase/Cloud backend (v0: Next.js; Bolt: any npm stack) | Static htm + `vite-react` / `react-postgres` scaffolds; brief expansion; sandbox stacks need live runtime | 🟡 |
| Plan vs. edit modes | Plan toggle → task list → Revise / Build here / Build in background | Chat mode (no code changes), Plan mode with versioned plans, Build mode | Build / Chat / Plan UI; local Plan stub; Temporal DAG deferred | 🟡 |
| Multi-file edits with diffs | Multi-file; diff in file history | Multi-file; code view + history diff | Multi-file patches; structured `file_change` + DiffView / Compare | 🟡 |
| Streaming file writes | Streams actions and file edits | Streams edits; preview keeps state while editing | Token streaming of tool JSON; files land at patch end | 🟡 |
| Runtime for generated app | Full Linux container (Nix), any language | Cloud build + preview (Bolt: in-browser WebContainers) | Code+compose for E2B/Temporal; default local = static, no agent shell | 🟡 |
| Live preview + hot reload | Webview of running dev server; HMR | Vite HMR, state-preserving | Static signed URL + HMR mode via preview-proxy (needs nginx `/p/` live) | 🟡 |
| Console output | Console/Shell panes, workflow logs | Console logs + network in preview; Cloud logs | Console bridge + Fix this error; admin-only host terminal; true sandbox PTY gap | 🟡 |
| Auto error detect + fix loop | Reads logs, retries | "Try to fix" on runtime/build errors; auto-fix | PipelineVerifier + console checks; live L0–L2 needs CommandRunner | 🟡 |
| Click-to-edit in preview | Element selector to target edits | Visual edits (text, colour, spacing) without credits; select element → chat | Inspector + deterministic codemod; full AST/recast deferred | 🟡 |
| Image-to-UI | Screenshot/image attachments | Image + Figma plugin import | Upload plumbing + URLs in goal; vision routing deferred | 🟡 |
| Checkpoints + rollback | Auto checkpoints incl. DB + agent context; rollback | Version history, restore, compare | Durable file checkpoints; DB snapshot live seam open | 🟡 |
| GitHub sync | Git pane, push/pull | Two-way sync incl. branch, restore-after-overwrite | Engine bridge + Settings UI; fake default; App tokens / signed webhooks live gap | 🟡 |
| Built-in DB / auth / storage | Postgres (dev + prod), Replit Auth, object storage | Lovable Cloud (DB, auth, storage, edge functions, AI, logs) / Supabase | Provision tool + Database tab; memory offline; Neon/`pg_dump` live gap | 🟡 |
| Env vars / secrets | Secrets pane, per-environment | Cloud secrets; connector keys | Project Secrets UI + secrets-broker store | 🟡 |
| Package installation | Agent installs (npm/pip/Nix) | Agent edits package.json; auto install | Sandbox tools when orchestrator+E2B live; local static = CDN/import-map | 🟡 |
| One-click publish + custom domain | Autoscale / Reserved VM / Static; custom domains; deploy rollback | Publish to `*.lovable.app`, buy/connect domain | Immutable checkpoint publish + static hosting provider; ACME/buy domain live gap | 🟡 |
| Sharing / remixing | Fork/remix Repls, share links | Public remix links, preview-before-remix | Visibility + `/build/share` remix | ✅ |
| Templates | Template gallery | Templates with Preview/Remix | `/build/templates` + recipes | ✅ |
| Responsive preview sizes | Device toggle | Desktop/tablet/mobile | Desktop / tablet / mobile / custom + URL bar | 🟡 |
| Agent tests its own app | App Testing: real browser, video replay | Browser testing incl. sign-in behind auth | Playwright when installed; offline stub + Tests tab; video/trace gateway gap | 🟡 |
| Project-level instructions | `replit.md` agent memory | Project Knowledge | `LOOP.md` injected into goal | ✅ |
| Steering mid-run | Yes | Follow-ups picked up at next stopping point | Yes (inbox drained per iteration) | ✅ |
| Cancel / budget visibility | Yes; effort modes | Credits per message | Stop + credits + effort tiers; metering via `LOOPIT_USAGE_URL` | ✅ |
| Security scanning | Built-in security scan | Quick + deep security scan | Security tab + publish gate; deep profiles / UI override polish open | 🟡 |
| Projects list / dashboard | Yes | Yes | `/build/projects` + project view | ✅ |

---

## 6. Target architecture decision: the runtime

Everything in Phase 1 depends on one choice. There are three options:

| Option | How | Pros | Cons |
| --- | --- | --- | --- |
| **A. Server sandbox (recommended)**: activate the E2B path that already exists | `services/scheduler` (E2B provider, `docker-compose.yml:62-88`) + `services/workspace-dispatch` (`e2b_runtime.py`) + `services/orchestrator` (Temporal) + `services/preview-proxy` (signed per-lease ingress). Template: `Loop-it/stack-templates/react-postgres` (Vite + Express + pg). | Matches Replit/Lovable (real Node, npm, backend, DB). Satisfies I1, because code runs only in the data plane. Already designed and partly tested. Loop-GPT already runs E2B (bot computers: `infra/e2b-gnome-desktop/`, orphan reaper commit `7cf35b8`). | E2B cost (per-second vCPU; Pro $150/mo + usage). Cold start of a few seconds (mitigate with a warm pool, `scheduler/pool.py`, and pause/resume). Needs Temporal Cloud. |
| **B. WebContainers (Bolt.new model)** | `@webcontainer/api` boots Node in the user's tab; agent writes files via the browser | Zero server compute for preview; instant HMR | **Commercial licence required** (quote-based); Chromium-centric, weak on iOS Safari (Loop ships a PWA and iPhone app); no real Postgres; the agent cannot run or test the app server-side unless a tab is open; conflicts with "run finishes without a watcher" (`runs.py:10-15`) |
| **C. Keep the no-build static stack** | Status quo | Cheap, safe | Cannot reach parity on backend, DB, auth, packages or testing |

**Recommendation:** use A for the agent's runtime and for preview. Keep C as a "Quick
prototype" stack for cheap, instant runs. Treat B as optional later, only as a client-side
fast preview for frontend-only edits.

---

## 7. Prioritized roadmap

Effort: **S** ≤ 3 engineer-days · **M** ≈ 1–2 weeks · **L** ≈ 3–5 weeks · **XL** > 5 weeks.
Engine paths are relative to `Loop-it/`. Web paths are relative to the repo root.

### Execution status (2026-10-20)

**Phase 0–3 product code is Done for the offline-first path.** Tables below mark each
roadmap item **Done** (or Done with an offline/compose qualifier). Remaining work is
almost entirely **credentials, cloud accounts, and deeper live wiring** — not greenfield
features. Live seams: `deploy/loopit/ENV.md`.

### Remaining live/cloud gaps

Consolidation of “Still open” notes from Phase 1–3 status blocks. Ship order is
credential/ops first, then deeper product polish.

**Seams closed in code (2026-10-20 follow-up):** dispatch `CommandRunner` into
`PipelineVerifier` when orchestrator + lease exist; nginx `/p/{project}/` →
`LOOPIT_PREVIEW_PROXY_UPSTREAM`; sandbox `HTTP_PROXY`/`HTTPS_PROXY` from
`LOOPIT_EGRESS_PROXY_URL` on E2B create + runtime env; scheduler
`POST /leases/{id}/pause|resume`; vision multimodal wiring via
`LOOPIT_VISION_ENABLED` + `LOOPIT_VISION_ENDPOINT_URL`.

1. **Temporal Cloud + E2B live** — turn on orchestrator mode + keys/template/warm pool
   (`ENV.md`). Code path is ready; accounts are not.
2. **True sandbox interactive PTY** — WS/line PTY + offline exec shipped; no byte-stream
   interactive PTY in workspace-dispatch yet (3.2).
3. **Neon branching + real `pg_dump` restore** — JSON stub + env seams; live Neon /
   Psycopg prod migrations still open (2.7 / 1.9).
4. **GitHub App install tokens + signed webhooks** — PAT/OAuth stub exist; App install +
   signed webhooks + checkout without `files` payload still open (2.3).
5. **ACME / Cloudflare for SaaS TLS** — Domains UI + fake CA; live ACME + registrar
   purchase deferred (2.4).
6. **Vision VL endpoint credentials** — multimodal message expansion + policy route
   shipped; needs a real `LOOPIT_VISION_ENDPOINT_URL` model.
7. **Plan DAG on Temporal** — local Plan stub shipped; live `dag_workflow` needs 1.1.
8. **Edge analytics + remaining ops** — sidecar page views shipped; app-proxy edge
   meters, Temporal Apply for background builds, deep security-scan / Publish override
   checkbox UI still open.

### Phase 0: stability and safety fixes (about 2–3 weeks). Ship before any wider launch.

| ID | Pri | Item | Current state | Reference behaviour | Implementation approach | Deps | Effort |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 0.1 | P0 | **Done.** Disable or isolate the user terminal (now admin-only) | B4: `terminal.py:31-88` runs `shell=True` on the API host | Replit and Lovable shells run inside the user's container only | Immediately: gate `/exec` behind `LOOPIT_TERMINAL_ENABLED` (default off) and hide the tab when health says disabled. Make `health.exec_enabled` truthful. Long term: route the terminal through `workspace-dispatch` into the project's sandbox (Phase 1.1). | none | S |
| 0.2 | P0 | **Done.** Durable checkpoints | B3: `InMemoryBlobStore` (`runs.py:784`) | Checkpoints survive forever (Replit: 7+ days for DB) | Add a filesystem or S3 `BlobStore` and a Postgres checkpoint index in `packages/checkpoint` (`blobs.py`, `records.py` already define the seams). Wire it in `RunManager.__init__`. Migrate the existing volume by snapshotting each project's current files on boot. | store DSN | M |
| 0.3 | P0 | **Done.** Rehydrate projects and runs after restart | B2/B16: in-memory maps | Projects persist | On a miss, `project_tenant`/`project()` resolve from `ProjectStore` (Postgres) plus the on-disk `<root>/<tenant>/<project>`. Extend `persist.py` to store title, stack, summary and the latest checkpoint. `get_run` returns files from disk for persisted runs. | 0.2 | M |
| 0.4 | P0 | **Done.** Publish serves an immutable checkpoint; unpublish / re-publish | B1: live workspace served | Deploy = immutable build; rollback to prior build | On deploy, materialize the checkpoint into `<root>/.deploys/<deployment_id>/` (read-only) and serve `/site/d/<deployment_id>/...` from it. Add "Unpublish" and "Re-publish version N". Keep tokens or move to public slugs (Phase 1.8). | 0.2 | M |
| 0.5 | P0 | **Done.** Meter builds against Loop-GPT credits (incl. preflight) | B7 | Credits per message or effort | Engine: on each model call, post a `kind=model` usage event (idempotency key `run:turn`) to `LOOPGPT_USAGE_URL` (`backend/src/routes/loopit.ts:198-244`) using the run's identity token. Preflight calls the same balance. Stop the run on 402. Remove the 2.0 identity-bridge seed when the bridge is on. | backend reservation semantics already exist | M |
| 0.6 | P0 | **Done.** Retry and Resend keep the project | B5 | Lovable/Replit edits stay in the same project | `useStartBuild` accepts `{prompt, projectId}`. Retry, Resend and Continue pass `projectId`. Add a unit test. | none | S |
| 0.7 | P0 | **Done.** Reset run state per run | B6 | n/a | `<RunView key={selected} runId={selected} />` in `page.tsx:30`. Also scope `seenSeqRef` by `runId`. Add a component test. | none | S |
| 0.8 | P0 | **Done.** Fix `/v1/build` upstream path | B8 | n/a | Proxy to `/api/runs` and `/api/runs/:id`. Forward `project_id`. Drop or implement `model`. Add a contract test against the engine's OpenAPI spec. | none | S |
| 0.9 | P1 | **Done (frontend).** Preview URL refresh | B11 | n/a | Return `expires_at` to the client and refetch at 80% of TTL, or issue a cookie-less, renewable path token. Remount only when the URL actually changes. | none | S |
| 0.10 | P1 | **Done (frontend client).** Stream robustness | B17 | n/a | Wrap `JSON.parse` in try/catch and skip the bad line. Reconnect when the stream closes while the status is live. Use the last `_seq` to resume, by adding a `?after=` param to `/events` that skips the replay prefix. | none | S |
| 0.11 | P1 | **Done (frontend).** Hide or fix dead controls | B9, B13, B14, B18, B19 | n/a | Hide gates in local mode. Fork navigates to a new run on the forked project, or shows a projects list. Rollback bumps the preview epoch, invalidates files and is refused while a run is live. Terminal `onError` shows a toast. "Continue" starts a follow-up run on the same project with the composer text. Preview any served path (B18). | 0.6 | S |
| 0.12 | P1 | **Done (engine).** Binary-safe workspace and serving | B12 | Images and fonts just work | Add `read_bytes` and `write_bytes` to `Workspace`. Add png/jpg/webp/gif/ico/woff2/mp4 to `SERVABLE_TYPES`. Snapshot bytes, not decoded text (`runs.py:1180`). | 0.2 | S |
| 0.13 | P2 | **Done.** Hygiene + B27 tests | B21–B24, B26, B27 | n/a | Sorted listing; lint fix; README update; `RunView` Vitest + Testing Library; Playwright `/build` with route mocks (offline_model_factory stack when available). | none | S |

#### Phase 0 status (2026-10-20)

**Phase 0 is complete for product code.** Items 0.1–0.13 are implemented. B27
verification tests land in this glue pass. Where a shipped fix differs from the
approach in the table, this list is authoritative. Phase 1–3 status blocks below
record offline-first Done items and live gaps (see also §7 Remaining live/cloud gaps).

- **0.1 Terminal (admin-only).** The engine refuses `/api/projects/<id>/exec` unless the
  identity token has scope `build:terminal`; project write access alone is not enough.
  Loop-GPT `/api/loopit/token` adds that scope only when `User.role === 'admin'` (the same
  flag `requireAdmin` uses). The dev single-tenant actor also has it. `/api/health` reports
  `terminal: "admin_only"`. The web Terminal tab is shown only when `/auth/me` returns the
  scope. Commands still run on the API host, so Phase 1.1 (sandboxed terminal) still applies.
- **0.2 Durable checkpoints.** `FileCheckpointStore` (`packages/checkpoint/.../durable.py`)
  keeps the existing `CheckpointStore` interface. Blobs go to a `FileSystemBlobStore` and a
  per-project JSON index, written atomically, goes under `<projects_root>/.checkpoints/`.
  This uses the projects volume that already holds run journals and deploy records; there
  is no Postgres index yet. Snapshot and restore are now byte-exact, which covers the
  checkpoint half of 0.12. Versions created before this change were in memory and are gone.
  There is no boot-time backfill: an existing project gets versions on its next run.
- **0.3 Rehydrate.** `project()` and `project_tenant()` fall back to the on-disk
  `<root>/<tenant>/<project>` tree, and the stack is inferred from the files. Persisted runs
  return their project's files and checkpoints, and `/runs/<id>/file` works for them.
  Title, summary and stack now survive restart via
  `<projects>/.runs/<run_id>.meta.json` (written from `persist_run_finished`) and are merged
  into `record_to_dict` / `get_run` (B16).
- **0.4 Immutable publish.** A deploy token's lease is `deploy-<deployment_id>`. The site
  route resolves the deployment record and serves that checkpoint's blobs, never the live
  workspace. The URL shape is unchanged. Links published before this change (lease
  `deploy-<project_id>`) keep the old live-workspace behaviour until their 30-day tokens
  expire. Engine APIs
  `POST /api/projects/{id}/deployments/{deployment_id}/unpublish` and
  `.../republish` flip `status` between `unpublished` and `live` without changing the
  checkpoint blob; unpublished deployments 404 on the site route. **Frontend:**
  `unpublishProject` / `republishProject` client methods call those paths; the publish
  banner shows Unpublish / Re-publish when `deployment_id` is present on the deploy
  response (no button if the id is missing).
- **0.5 Metering.** When `LOOPIT_USAGE_URL` is set (Loop-GPT backend `/api/loopit/usage`),
  every model call posts an `inference` event with key `<run>:model:<n>`. The token is minted
  for the run's actor and workspace. Metering fails closed: a 402 stops the run as
  `budget_exceeded` ("out of Loop credits"), and an unreachable or refusing parent stops it as
  `error`. `POST /api/runs` now preflights parent balance via `GET /api/loopit/credits`
  (derived from the usage URL). When the usage bridge is on, the 2.0 identity-bridge engine
  credit seed is not written.
- **0.6 Retry/Resend** pass the run's `projectId`. **0.7** keys `RunView` by run id, so all
  per-run state (including `seenSeqRef`) resets. **0.8** proxies to `/api/runs` and
  `/api/runs/:id`.
- **0.9 Preview URL refresh (frontend).** `createPreviewUrl` returns `{ url, expiresAt }`
  (engine `expires_at` when present, else now+900s). `usePreviewUrl` refetches at 80% of
  remaining TTL. The iframe key is the URL string (+ epoch for intentional reloads).
- **0.10 Stream robustness (frontend client).** `parseSseChunk` guards `JSON.parse`.
  `useRunStream` reconnects on clean close while `live`, passing `?after=<lastSeq>`.
  Engine must honour `?after=` on `/runs/{id}/events` (skip journal prefix); if it ignores
  the param, client de-dupe by `_seq` still prevents double bubbles.
- **0.11 Dead controls (frontend).** Gates hidden unless `health.run_execution_mode ===
  'orchestrator'`. Fork navigates via a new run on returned `project_id` (toast "Copy
  saved"). Rollback refused while live, bumps preview epoch, invalidates file/preview
  queries. Continue starts a follow-up run with composer text. Preview serves any path
  (fallback `index.html`). Terminal `onError` toast (B15) shows on exec failure.
  Glue fix: `AppPage` `width="fill"` now renders the shared title/actions row so
  Stop / Continue / Retry / Publish are visible on `/build` run views.
- **0.9 (engine).** `POST /api/projects/{id}/preview` returns `expires_at` (unix seconds)
  and `expires_at_iso`. Frontend consumes these (see 0.9 frontend bullet above).
- **0.10 (engine).** `GET /api/runs/{id}/events?after=<seq>` skips journal events with
  `_seq <= after`. Frontend reconnect + parse guard shipped (see 0.10 frontend bullet).
- **0.11 (engine half of B14).** Rollback returns 409 while a run is live on the same
  project (`project_has_live_run`). Frontend also refuses rollback while live and bumps
  the preview epoch (see 0.11 frontend bullet).
- **0.12 Binary-safe workspace.** `Workspace.read_bytes` / `write_bytes`; site serving uses
  bytes; `SERVABLE_TYPES` includes png/jpg/jpeg/webp/gif/ico/woff2/mp4. Snapshots were
  already byte-exact.
- **0.13 Hygiene + B27 tests.** Goal file listing is sorted (B21). `confirm.tsx`
  exhaustive-deps fixed (B22). `deploy/loopit/README.md` no longer calls `/build` a
  placeholder (B23). Activity icons prefer `kind`/`tool`/`tone` with regex fallback
  (B24). Marketing copy no longer promises one-click publish (B26). Vitest + Testing
  Library covers Continue/`projectId`, fork navigation, rollback refuse/epoch, non-html
  preview fallback, and stream reconnect (`hooksPhase0` / `runViewPhase0`). Playwright
  `tests/e2e/build.spec.ts` exercises `/build` against route-mocked Loop-it APIs
  (including deploy → `deployment_id` → Unpublish). **Blocker for full offline_model_factory
  Playwright:** needs `deploy/loopit` compose up with `LOOPIT_MODEL_FACTORY=offline` (or
  equivalent), a `LOOPIT_ENABLED=1` web export, and nginx/`LOOPIT_API_URL` wiring — not
  assumed in the default static `out/` e2e server.

### Phase 1: core parity, a real runtime and real apps (about 8–12 weeks)

| ID | Pri | Item | Current state | Reference behaviour | Implementation approach | Deps | Effort |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1.1 | P1 | **Done (code+compose).** Sandboxed runtime per project | Orchestrator, scheduler (E2B), workspace-dispatch and preview-proxy exist. Local mode is in production, and orchestrator mode is half-wired (B10). | Replit: container per Repl. Lovable: cloud preview. | Deploy `orchestrator` (Temporal Cloud), `workspace-dispatch` and the E2B template from `sandbox/image/Dockerfile` (Node 20, pnpm, Playwright). Make every `/api/projects/*` route resolve the project's lease through the scheduler. Unify local and orchestrator `get_run` so files, DAG and checkpoints come from the store. Use pause/resume for idle projects and a warm pool (`scheduler/pool.py`). | 0.2, 0.3, Temporal Cloud account | XL |
| 1.2 | P1 | **Done (code+compose).** Agent shell, package install and dev server | `run_shell` always refuses (`workspace.py:190-209`) | The agent runs `npm install`, migrations and tests | Expose the existing contract tools (`packages/tools/registry.py`, `schemas.py`) through workspace-dispatch inside the sandbox: `run_shell`, `install_package`, `start_dev_server`, `read_logs`. Remove the "no shell" lines from `SYSTEM_PROMPT` for sandbox stacks. Egress goes through `services/egress-proxy` with an npm/pypi allowlist (I3). | 1.1 | L |
| 1.3 | P1 | **Done.** Full-stack templates (`vite-react`, `react-postgres`) | Was: only static + htm React | Lovable: React/Vite/Tailwind/shadcn. v0: Next.js. | `stacks.py` scaffolds from `stack-templates/`; JSX+npm guidance; `react` remains Quick prototype; sandbox stacks use `system_prompt_for(shell_enabled=…)` when orchestrator is on. | 1.1 | M |
| 1.4 | P1 | **Done.** Live preview with HMR via preview-proxy | Was: iframe remount of static files | Vite HMR, state-preserving | Dynamic `/internal/routes` bind; path `/p/{project}/` or subdomain; WS proxy; RunView skips remount when `mode=hmr`. Offline keeps signed static site URLs. | 1.1 | M |
| 1.5 | P1 | **Done.** Console, logs and runtime errors | Was: no app console | Console pane; "Try to fix" | Bridge script in preview-proxy HTML; Console tab; SSE `log` events; `POST …/console` + "Fix this error" steering/follow-up. | 1.4 | M |
| 1.6 | P1 | **Done (offline + pipeline hook).** Real verification | Was: parse-only `PreviewVerifier` | Agent fixes build/runtime errors | `PipelineVerifier` wraps PreviewVerifier; console errors fail checks; sandbox stacks run `packages/verify` levels when a CommandRunner is wired (orchestrator). | 1.2, 1.4 | L |
| 1.7 | P1 | **Done (local Chat/Build + Plan stub).** Plan mode and Chat mode | Single fake DAG node | Replit Plan toggle; Lovable Chat and Plan modes | Composer gets a mode switch: Build / Plan / Chat. Plan calls `packages/planner` (`planner.py`, `dag.py`) to produce a multi-node DAG, shown as an editable task list with Approve, Revise and Cancel. Approve starts a DAG run (`orchestrator/dag_workflow.py`). Chat answers with read-only tools and bills as chat. | 1.1 for DAG execution; Chat can ship earlier on local mode | L |
| 1.8 | P1 | **Done (static + interfaces).** Real publishing (hosting) | Signed 30-day link (B1) | Replit Autoscale/Static. Lovable `*.lovable.app`. | Wire `services/deployer/core.py` (builds from green checkpoints, Fly-class provider). Static stacks go to object storage + CDN (Cloudflare R2/Pages or S3+CloudFront). Full-stack goes to Fly Machines (`infra/fly/*`, ADR-0020). Default URL `<opaque>.loop-apps.<domain>` from `services/domains`. Add publish history and rollback to a prior deployment, plus an Unpublish action. | 0.4, 1.3 | XL |
| 1.9 | P1 | **Done (memory + APIs).** Built-in DB, auth and storage | `packages/provision` (RLS, JWT issuer, storage) exists, unwired | Replit DB + Auth. Lovable Cloud / Supabase. | Expose a `provision` agent tool (`packages/provision/tool.py`) behind a confirmation gate (I7). Provision a per-project Postgres schema/database (Neon or a shared cluster with RLS) for dev and a separate one for prod at publish time (Replit model). Add a Database tab with a table browser. Auth uses the template's JWT plus `GeneratedAppJwtIssuer`. Storage uses an S3 prefix per project. | 1.1, 1.3, gates (1.10) | XL |
| 1.10 | P1 | **Done.** Working approval gates | UI exists; local mode inert (B9) | Replit asks before destructive DB ops | In orchestrator mode, gates come from `loop.py:366-373`. Wire `ApprovalSignal` (exists). Show gate cards in run chat as well as in the top banner. | 1.1 | M |
| 1.11 | P1 | **Done (UI + broker store).** Environment variables and secrets UI | `services/secrets-broker` exists, unwired | Replit Secrets. Lovable Cloud secrets. | Add a project Settings → Secrets panel using an encrypted store (secrets-broker Postgres store; Loop-GPT already has an AES-GCM vault pattern in `WorkspaceConnection`). Inject secrets into the sandbox env and the deploy env, never into the client bundle (the template enforces the `VITE_` prefix). The agent can request a secret, which raises a gate card asking the user to paste it. | 1.1 | M |
| 1.12 | P1 | **Done.** Diff viewer and file-change list | Raw JSON patch in chat | Code view with diffs per change | Emit structured `file_change {path, op, diff, additions, deletions}` events from `apply_patch` (`workspace.py:156-188`). The UI shows "Changed files" chips per assistant turn and a Monaco diff viewer (`@monaco-editor/react`) in the code drawer. Add per-checkpoint "Compare with previous". | none (works on local mode) | M |
| 1.13 | P1 | **Done.** Projects as a first-class entity | Only runs exist in the UI | Project dashboard; one chat per project | Add `/build/projects` and a project view: one continuous chat across runs, a current preview, versions and settings. Runs become turns within a project. Use `ProjectStore` (exists). Rename, delete (with a 30-day restore, as Lovable does) and duplicate. | 0.3 | M |
| 1.14 | P1 | **Done.** Project instructions / knowledge | None | `replit.md` and Lovable Knowledge | Use a `LOOP.md` at the project root (or a settings field), always injected into the goal after the user's request. The agent may propose edits to it. | none | S |
| 1.15 | P1 | **Done (upload plumbing).** Image-to-UI and attachments | `/build` is text-only; chat has uploads; `loopitBuiltin.ts` passes only file ids as text | Paste screenshot or Figma → UI | Add image paste and drop to both composers. Upload through the existing `PrivateFile` service, pass signed URLs into the run, and route to a vision-capable model in `router_policy_from_env`. Images can also be saved into the project's `public/` folder (needs 0.12). | 0.12, a VL model endpoint (the current models are text-only, per `docs/BUILD_PROGRESS.md` §03r) | M |

#### Phase 1 status (2026-10-20) — 1.1–1.2 + local UX (1.7, 1.12–1.15, B20)

**1.1 Sandboxed runtime (code + compose).** `deploy/loopit/docker-compose.yml`
now includes `egress-proxy`, `workspace-dispatch`, and an `orchestrator` profile
(Temporal Cloud / external frontend — no embedded Temporal server). Scheduler
defaults to `LOOPIT_SANDBOX_PROVIDER=memory` for offline; set `e2b` +
`E2B_API_KEY` + `LOOPIT_E2B_TEMPLATE_ID` for live. API: `SchedulerClient` /
`DispatchClient`; `/api/projects/*` resolve tenant via store+disk; `GET
.../lease` acquires/renews when mode is orchestrator; unified `get_run` merges
Temporal status with files/checkpoints/DAG from the store (B10); run meta
sidecar records orchestrator metadata across restarts. Warm pool env wired;
`pause_assigned` / `resume_assigned` are documented NotImplemented hooks
(release + refill is the idle path today). Env docs in `deploy/loopit/ENV.md`.

**1.2 Agent shell / packages / dev server.** Contract + registry +
workspace-dispatch allowlist expose `run_shell`, `install_package`,
`start_dev_server`, `read_logs` (wrappers around sandbox `run_shell`).
`SANDBOX_SYSTEM_PROMPT` / orchestrator worker prompt allow shell; local static
`SYSTEM_PROMPT` still refuses. Egress-proxy is in the side-by-side compose with
the npm/pypi allowlist. Local `Workspace.run_shell` remains refuse-only (I1).

**1.3–1.6 (2026-10-20).** Full-stack templates, HMR preview, console bridge,
and verify pipeline hook are implemented in code:

- **1.3** `vite-react` + `react-postgres` in `stacks.py` / `stack-templates/`;
  `SANDBOX_SYSTEM_PROMPT` when `sandbox_tools` (orchestrator) + sandbox stack.
  Offline still scaffolds files; local mode keeps the no-shell prompt.
- **1.4** preview-proxy dynamic bind + path routing + WS; API returns
  `mode: hmr|static`; RunView does not remount on tool calls in HMR mode.
- **1.5** console bridge injection; Console tab; SSE `log`; Fix this error.
- **1.6** `verify_bridge.PipelineVerifier` + console-as-failing-check; live
  L0–L2/SAST when a sandbox `CommandRunner` is supplied (still `None` on
  local RunManager — dispatch runner is the remaining wire-up).

**Still open after 1.3–1.6:** live Temporal Cloud + E2B credentials; dispatch
CommandRunner into `build_verifier`; pause/resume HTTP on scheduler; sandbox
`HTTP_PROXY` → egress; nginx path fronting for `/p/{project}/` in prod.

**1.7 Chat / Build / Plan (local).** Composer mode switch on `/build` and
project continue: Build (default writes), Chat (read-only tools; `apply_patch`
refused), Plan (local multi-node stub DAG + Approve/Revise/Cancel shell;
Approve starts a Build run). **Still open / deferred:** Plan DAG execution via
Temporal (`orchestrator/dag_workflow.py` / real planner) — needs 1.1.

**1.12 Diff viewer.** `apply_patch` emits structured `file_change` SSE events;
RunView shows changed-file chips and a lightweight unified DiffView in the code
drawer (Monaco deferred); checkpoint Compare opens prior vs live.

**1.13 Projects.** `/build/projects` list + project view (`?id=`); rename /
archive / restore / duplicate via ProjectStore; runs listed as turns; LOOP.md
settings; navigation from run view back to project.

**1.14 LOOP.md.** Project-root `LOOP.md` (or settings PUT) is injected into
every goal after the user request; agent may patch it in Build mode.

**1.15 Image attachments (plumbing).** Paste/drop on build composers uploads
via PrivateFile, mints signed URLs, passes `attachment_urls` into the run goal
as text. **Still open / deferred:** vision-capable model routing in
`router_policy_from_env` (hosted models remain text-only).

**B20 loopit-mcp.** Compose service `loopit-mcp` (port 8010) added; document
`LOOPIT_MCP_URL` (https) on the Loop-GPT backend so chat `start_run` appears.

#### Phase 1 status (2026-10-20) — 1.8–1.11 hosting / DB / gates / secrets

**1.8 Real hosting.** API deploy calls `publish_via_hosting` after the Phase 0
signed site URL. Default `StaticObjectHostingProvider` writes under
`<projects>/.hosted/`; optional opaque
`https://p-….${LOOPIT_APPS_BASE_DOMAIN}` or domains-service allocate; Fly when
`LOOPIT_DEPLOYER_PROVIDER=fly` + token. Publish history supersedes prior live
rows; rollback / unpublish / republish endpoints. Offline keeps signed URLs.

**1.9 DB / auth / storage.** `project_backend` + gated `provision` tool;
Database tab; JWT + S3 prefix metadata; memory offline, Postgres when DSN set.

**1.10 Approval gates.** Local `RunManager.decide_gate` resumes runs; gate
cards in chat; `health.local_gates=true`. Orchestrator ApprovalSignal unchanged.

**1.11 Secrets.** Project Settings → Secrets via secrets-broker store;
`request_secret` tool; inject names into sandbox/deploy env only (`VITE_` refused).

### Phase 2: advanced parity (about 8–10 weeks)

#### Phase 2 status (2026-10-20) — 2.1–2.9

**2.3 GitHub sync.** `loopit_api/gitsync_bridge.py` wraps `loopit_gitsync` with
`FakeGitProvider` (default) or `GithubProvider` when `LOOPIT_GITSYNC_PROVIDER=github`
+ `LOOPIT_GITHUB_TOKEN`. Bind / status / push / webhook under
`/api/projects/{id}/git*`. Verified-run hook auto-pushes when bound. Webhook pull
→ new checkpoint + workspace refresh; conflict → `loopit-backup-*` branch.
Loop-GPT `GET /api/loopit/github-sync/connect` stubs OAuth (live when
`GITHUB_CLIENT_ID` is set → connector vault). **Still open / live:** GitHub App
install tokens, signed webhooks, live checkout without a `files` payload.

**2.4 Custom domains.** Settings → Domains; claim/verify via `domains_bridge`
(in-process DomainService + fake TLS offline, or `LOOPIT_DOMAINS_URL`). Offline
verify seeds TXT; meters `custom_domain_months` when `LOOPIT_USAGE_URL` is set.
**Still open / live:** ACME / Cloudflare for SaaS; registrar purchase UI.

**2.5 Sharing / remix.** Visibility sidecar (private / link / public_remix);
`/build/share/?id=`; Remix forks latest verified checkpoint (no chat/secrets).

**2.6 Templates.** `/build/templates` from curated starters +
`stack-templates/recipes/*.json`; Remix starts a Build run.

**2.1 Visual / click-to-edit.** Preview-proxy injects console + inspector
bridges (`inject_preview_bridges`); static site responses inject the same.
Parent posts `inspect-mode`; click returns `{selector, snippet, loc, tag, text}`.
Vite `plugins/dataLocTagger.ts` stamps `data-loc` in vite-react and
react-postgres templates (dev serve). Composer shows an "editing" chip;
`POST …/visual-edit` applies a deterministic text/colour/spacing codemod when
`data-loc` resolves, else returns an LLM patch prompt. **Still open:** full
`recast`/`babel` AST codemod in the sandbox; live HMR opaque-origin edge cases.

**2.2 Agent browser self-testing.** `POST/GET …/browser-tests` runs Playwright
when installed, otherwise an offline stub that writes
`.artifacts/browser-tests/<project>/<id>/{manifest,steps,result}` (bot-recording
shape). UI Tests tab shows a Test run replay card. Seeded test user when
`auth_ready` from project backend meta. Defaults to offline
(`force_offline` / `LOOPIT_BROWSER_TEST_OFFLINE`). **Still open:** acceptance
criteria from Plan DAG; live video/trace serving through the gateway.

**2.8 Security scan surface.** Security tab + `POST/GET …/security-scan` uses
gitleaks / npm audit / semgrep when on PATH, else offline stub (clean pass).
Findings include plain-language copy. Deploy auto-scans if none cached and
returns **409** on blocking findings unless `override_security=true`.
**Still open:** deep scan profiles; Publish dialog override checkbox (API flag
wired; UI still uses the confirm reason only).

**2.7 Dev vs prod DB.** `project_database_names(..., environment=)` keeps the
historic `dev` digest and allocates a separate `prod` schema. First publish
calls `apply_migrations_at_publish` from `publish_via_hosting` (wired through
`project_backend`). Database tab / API accept `?environment=dev|prod`.
Checkpoints may carry `db_snapshot_id` from a JSON stub under
`.db-snapshots/` (Neon branch / `pg_dump` seam when `LOOPIT_NEON_API_KEY` or a
live DSN is set). **Still open:** live Neon branching and real `pg_dump`
restore; Psycopg provisioner for prod migrations beyond the in-memory fake.

**2.9 Background builds.** Plan Approve offers **Build in background**. Local
mode starts a normal build thread with `background=true`; on finish a pending
review is created, the main checkpoint pointer is restored to the pre-build
base, and a notification is recorded. The Build board shows a notifications
badge; **Apply changes** opens a diff review (1.12 `file_changes`) then
promotes the pending checkpoint. Orchestrator/Temporal starts remain detached
by nature; pending-review merge is local-mode today. **Still open:** Temporal
workflow signalling for Apply; orchestrator-path pending reviews.

| ID | Pri | Item | Current state | Reference behaviour | Implementation approach | Deps | Effort |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2.1 | P1 | **Done (offline + HMR inject).** Click-to-edit / visual edits | Was: none | Lovable visual edits; Replit element selector | Inspector overlay via preview-proxy (+ static site inject). Click → `{selector, snippet, loc}`. Vite `dataLocTagger` in vite-react / react-postgres. Composer "editing" chip + deterministic text/colour/spacing codemod (LLM fallback). | 1.3, 1.4 | L |
| 2.2 | P1 | **Done (offline stub + API/UI).** Agent self-testing in a browser, with replay | Was: parse-only | Replit App Testing (video replay); Lovable browser testing, including signing in | Playwright when installed; offline stub writes manifest/steps artifacts. Tests tab + Test run replay card. Seeded test user when auth provisioned. | 1.6, 1.9 | L |
| 2.3 | P1 | **Done (offline + stub).** GitHub two-way sync | Was: `packages/gitsync` unwired | Lovable two-way sync; Replit Git pane | Engine `gitsync_bridge` + project Settings → GitHub sync. Fake provider default; `LOOPIT_GITSYNC_PROVIDER=github` + token for live. Push on verified checkpoint; webhook pull → new checkpoint + workspace refresh; conflict → `loopit-backup-*` branch. Loop-GPT `GET /api/loopit/github-sync/connect` stub/live OAuth vault. | 0.2, 1.13 | L |
| 2.4 | P1 | **Done (offline + seams).** Custom domains | Was: `services/domains` unwired | Connect or buy a domain on paid plans | Settings → Domains UI; TXT challenge via in-process DomainService (fake) or `LOOPIT_DOMAINS_URL`; TLS via FakeCertificateAuthority / ACME seam; meters `custom_domain_months` when `LOOPIT_USAGE_URL` set. | 1.8 | M |
| 2.5 | P2 | **Done.** Sharing and remixing | Was: fork hidden | Lovable public remix with preview-before-remix | Visibility private / link / public_remix (`.sharing/` sidecar). `/build/share/?id=` public page + Remix (fork latest checkpoint, no chat/secrets). | 1.8, 1.13 | M |
| 2.6 | P2 | **Done.** Templates gallery | Was: chips only; recipes unused | Template gallery with Preview and Remix | `/build/templates` from curated starters + `stack-templates/recipes/*.json`; Preview prompt + Remix starts a Build run. | 2.5 | M |
| 2.7 | P2 | **Done (memory + publish path).** Dev vs. prod data separation and DB restore | Was: single schema | Replit dev/prod DBs; point-in-time restore | Separate prod schema at first publish; migrations applied in `publish_via_hosting`; optional checkpoint `db_snapshot_id` via JSON stub (Neon/`pg_dump` seam). | 1.9 | L |
| 2.8 | P2 | **Done (offline stub + gate).** Security scan surface | Was: `verify/sast.py` unwired | Lovable quick and deep security scans | Security tab runs Semgrep/gitleaks/npm audit (or offline stub via `loopit_verify` parsers). Plain-language findings. Publish blocked on critical with `override_security` gate. | 1.6 | M |
| 2.9 | P2 | **Done (local + notify).** Background builds | Was: only foreground approve→build | Replit "Build in background" | `background=true` runs detached (local thread; Temporal when orchestrator). Pending review + notifications badge; Apply changes shows 1.12 diffs before promoting the checkpoint. | 1.7, 1.12 | M |

### Phase 3: polish (about 4–6 weeks, ongoing)

#### Phase 3 status (2026-10-20) — 3.1–3.9

**3.1 Editable Monaco editor.** `CodeEditorDrawer` ships `@monaco-editor/react`
with file tree + search. Save → `POST /api/projects/{id}/apply-patch` generates
a unified diff, applies via `workspace.apply_patch` (I6), and snapshots a
`user edit` checkpoint (409 while a run is live).

**3.2 Interactive terminal (PTY).** `GET …/pty` + `WS …/pty/ws` prefer
workspace-dispatch `run_shell` when leased; else admin host exec. UI uses
xterm.js when available, otherwise offline exec with per-project localStorage
history. **Gap:** true byte-stream sandbox PTY (dispatch has no interactive PTY).

**3.3 Preview sizes + URL bar.** Tablet (768), custom width, URL bar, route
picker, back/forward, open in new tab, SEO panel via `GET …/preview-meta`.

**3.4 State-preserving preview.** HMR keeps `key={url}` (no epoch remount).
Visual edits in HMR skip epoch bump and keep inspect selection when possible.

**3.5 Mobile / PWA.** `MobileBuildSplit` shows Preview | Chat tabs below
`md`; desktop keeps the existing grid. Native `mobile/src/screens/Build.tsx`
embeds `/build` in `react-native-webview` when the module is present, with a
browser fallback.

**3.6 Cost / effort.** `EffortSwitch` (Quick / Standard / Deep) maps to engine
`tier`; `CostTransparencyBar` + `EffortEstimateNotice` before Deep / Plan
Approve. Client heuristic estimates; live metering still via `LOOPIT_USAGE_URL`.

**3.7 Connectors.** Engine `.connectors/` sidecar + project Settings →
Integrations (Stripe / Resend / AI router). Status `configured` when matching
project secrets exist; otherwise enable as offline stub. UI also probes
`/api/agent/connectors` for a workspace Stripe vault key.

**3.8 Analytics.** Sidecar `.analytics/` increments HTML page views on
published (deploy-lease) site serves. Project Analytics panel + offline seed.
**Gap:** app-proxy `billing.py` is not in this stack — edge meters deferred.

**3.9 Collaboration.** Presence heartbeats + shared project chat under
`.collab/` (poll). Presence indicator + Collaboration panel on the project
page. Workspace roles continue to gate access.

| ID | Pri | Item | Approach | Effort |
| --- | --- | --- | --- | --- |
| 3.1 | P2 | **Done.** Editable code editor | Monaco with a file tree and search. User edits become checkpoints through `apply_patch` (generate a diff from the edit to keep I6). | M |
| 3.2 | P2 | **Done (line PTY + offline exec).** Interactive terminal (PTY) | Use xterm.js plus a websocket to the sandbox PTY through workspace-dispatch. History persists per project. | M |
| 3.3 | P2 | **Done.** More preview sizes and a URL bar | Tablet (768), custom width, a route picker, back/forward, open in new tab, and social/SEO cards (as Lovable does). | S |
| 3.4 | P2 | **Done.** State-preserving preview during edits | Comes from HMR (1.4). Also keep the selection between visual edits. | S |
| 3.5 | P2 | **Done (responsive + WebView).** Mobile and PWA build UX | Responsive split view (preview/chat tabs on small screens). The native app opens a native WebView instead of the external browser (`mobile/src/screens/Build.tsx`). | M |
| 3.6 | P2 | **Done.** Cost and effort transparency | Show credits per turn, a mode selector (Quick / Standard / Deep, which already maps to `tier`), and an estimate before a large plan runs. | S |
| 3.7 | P2 | **Done (offline + secrets).** Integrations and connectors for generated apps | Stripe, email (Resend is already used by Loop-GPT) and AI-in-app through the router. Use the existing Loop-GPT connector catalog for keys. | L |
| 3.8 | P2 | **Done (sidecar).** Analytics for published apps | Page views from the edge (app-proxy `billing.py` already counts requests). | M |
| 3.9 | P2 | **Done (poll).** Collaboration | Workspace roles already exist. Add a presence indicator and a shared project chat. | M |

---

## 8. Dependency graph and suggested sequencing

```
0.6, 0.7, 0.8, 0.9, 0.10, 0.11, 0.13 ─── ship in week 1 (front end and gateway only)
0.1 (terminal off) ───────────────────── ship immediately
0.2 ─► 0.3 ─► 0.4 ─► 0.12               (durability, then immutable publish)
0.5 (metering) ───────────────────────── before any paid exposure
          │
          ▼
1.1 runtime (Temporal Cloud + E2B + dispatch + preview-proxy)
   ├─► 1.2 shell and packages ─► 1.3 full-stack template ─► 1.4 HMR preview ─► 1.5 console ─► 1.6 real verify
   ├─► 1.10 gates ─► 1.9 DB/auth/storage ─► 2.7 dev/prod DBs
   ├─► 1.11 secrets
   └─► 1.8 hosting ─► 2.4 domains ─► 2.5 remix ─► 2.6 templates
1.12 diffs, 1.13 projects, 1.14 knowledge, 1.7 Chat mode ─── can run in parallel on local mode
1.6 + 1.9 ─► 2.2 self-testing      1.3 + 1.4 ─► 2.1 visual edits      0.2 + 1.13 ─► 2.3 GitHub
```

**As of 2026-10-20:** Phase 0–3 offline-first code is implemented. Remaining calendar time
is dominated by **live Temporal Cloud + E2B**, credentialed GitHub/ACME/Neon, and the
gaps in §7 “Remaining live/cloud gaps” — not by rebuilding Phase 0–3 product surfaces.
Original estimate (for reference): Phase 0 ~3 weeks, Phase 1 10–12 weeks (runtime critical),
Phase 2 8–10 weeks; rough total to full live parity **5–6 months** from the planning start.

---

## 9. What cannot be replicated exactly, and the closest alternative

| Reference feature | Why not exactly | Closest achievable |
| --- | --- | --- |
| Bolt's in-browser runtime (WebContainers) | Commercial licence; weak iOS Safari support; conflicts with unattended runs and I1-style server verification | E2B sandboxes plus HMR through preview-proxy. Optionally WebContainers later as a frontend-only "instant preview" after licensing. |
| Replit's Nix-based "any language" containers | One opinionated stack is a deliberate design choice (ADR-0011) to keep verification and SAST tight | Two stacks: `react-postgres` (full stack) and static/htm (quick). Add a Python stack only after Phase 3. |
| Lovable Cloud's managed Supabase-like backend at scale | Large surface (edge functions, realtime, auth providers) | `packages/provision` Postgres + RLS + JWT auth + S3 storage, plus Express routes as "functions". Optionally let users connect their own Supabase. |
| Lovable's credit-free visual edits | They need a deterministic source-mapped codemod for every element type | A codemod for text, colour, spacing and class changes; everything else falls back to a cheap LLM patch. |
| Domain purchase inside the product | Needs a registrar reseller agreement | Connect an existing domain first (`services/domains`). `registrar.py` is a seam for a later reseller. |
| Frontier-model quality | The router defaults to self-hosted "abliterated" HF models (`app.py:238-262`), which are weaker at long agentic coding | Let the router pick a stronger coder model for Plan and Build where the content policy allows. Keep the brief and planner on the planner tier. Measure with `Loop-it/evals`. |
| Image-to-UI today | Upload plumbing shipped (1.15); hosted models are still text-only (`docs/BUILD_PROGRESS.md` §03r) | Vision routing deferred until a VL endpoint exists. |

---

## 10. Open decisions for the owner

1. **Runtime:** E2B server sandboxes (recommended; already wired in code) versus a
   WebContainers licence versus a hybrid. This also sets the E2B plan, cost per build-minute
   and pause/resume policy.
2. **Durable orchestration:** Temporal Cloud (recommended by `deploy/loopit/README.md`)
   versus keeping a hardened local `RunManager` with Postgres-backed state for the next 2–3
   months.
3. **Publishing target:** Fly Machines (the deployer and ADR-0020 point here) versus
   Cloudflare (R2/Pages + Workers for static, Containers for full stack) versus Railway (the
   current Loop-GPT host). Also the default app domain (for example `*.loop-apps.cyou`).
4. **Generated-app stack:** finish `react-postgres` (Express + pg) versus switch to
   Next.js (as v0 does) versus Vite + Supabase-compatible APIs (as Lovable does). Decide
   whether to keep the htm "Quick prototype" stack.
5. **Database provider for generated apps:** a shared Postgres cluster with per-project
   schemas and RLS (cheap) versus Neon per project (branching enables DB checkpoints, as
   Replit does).
6. **Model policy for Build:** keep the "unrestricted" HF default (`app.py:238-262`) or allow
   stronger hosted coder and vision models for Build, and how that fits the content policy.
7. **Billing model:** per-turn credits (as Lovable does) versus effort tiers (as Replit
   does), and how sandbox-seconds and hosting-seconds (already in the `/api/loopit/usage`
   schema) are priced.
8. **Terminal:** remove it until sandboxes exist, or keep it as an admin-only debug tool.
9. **Repository layout:** keep `Loop-it/` as a nested repo (current) or import its history
   into the monorepo before the large Phase 1 changes (`deploy/loopit/README.md:7-8`).
