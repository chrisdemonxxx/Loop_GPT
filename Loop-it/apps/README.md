# Running the local preview

A two-process preview of the product: a FastAPI service that drives the **real**
agent loop, and a React app that watches it. It exists so the experience can be
judged before Phase 3 builds durable orchestration behind it.

## What it is not

It is not the platform. Three things are deliberately missing, and the UI says
so rather than papering over them:

- **No sandbox, and therefore no execution.** Runs happen in a directory on this
  machine, so `run_shell` always refuses: executing model-authored commands on
  the control plane is what invariant I1 forbids, and there is no flag to turn
  it on. An invariant with a local-preview exemption is not an invariant — the
  repository's own I1 guard fails the build on a `subprocess` call in a
  control-plane service.
- **No database, no deploy.** The `provision`, `deploy` and `browser` tools are
  not wired up, so nothing here exercises RLS or the deployment path.
- **No durability.** Runs live in memory. Restarting the API forgets them.

## Start it

Two terminals, from the repository root.

**Terminal 1 — API**

```powershell
$env:PYTHONPATH = "apps/api/src;packages/agent-core/src;packages/patch/src;packages/contracts/src;services/router-svc/src"

# Live, against real models:
$env:HF_TOKEN = "hf_..."
python -m loopit_api --bill-to red-kit

# Or, to look at the interface without calling a model:
python -m loopit_api --offline
```

**Terminal 2 — web**

```powershell
cd apps/web
pnpm dev
```

Then open <http://localhost:5173>.

## Offline mode

Without `HF_TOKEN` the API starts offline and every run uses a scripted client.
The header says `offline — scripted, no model`, because a scripted client is a
demo of the UI and must never be mistaken for a demo of the platform.

## How a run finishes

An agent never declares its own success — only verification ends a run. The
preview has no sandbox, so it verifies the strongest thing it can honestly
establish:

- every file the agent wrote **parses** — `ast.parse` for Python, `json.loads`
  for JSON and a tree-sitter parse for JavaScript, all of which read and never
  run. JavaScript is what the generated app is actually written in, so leaving
  it unchecked meant the one thing that had to parse was the one thing nobody
  parsed: a run went green on an `App.js` that stopped in the middle of a
  template literal and rendered a blank page;
- every local file a page **references** actually exists. A page linking a
  `app.js` that was never written parses perfectly and is broken in the
  browser, and the more files a project has the more chances there are for one
  of these;
- every module is **reachable**. The mirror image, and the harder one to see: a
  component written into its own file and never imported is a run that reports
  success and a page that looks unchanged;
- markup is **styled**. Structure whose class names have no rules anywhere
  renders as black text on white, which is not a finished app. Only a majority
  of unstyled names fails — a few unstyled utility classes are normal, and
  blocking on those turned a working app into a stalled run;
- nothing the browser will **reject at runtime**: JSX in a file with no build
  step, or a string passed to `style`, which React throws on so that nothing
  mounts at all;
- the agent has **re-read its own work** afterwards. This is what stops a run
  going green the moment the first file lands.

A red verdict is not an error — it is the next input, so the agent gets the
missing file written inside the same run. The wording of one matters more than
it looks: an unterminated file makes tree-sitter report byte zero, and an agent
told its problem is on line 1 rewrites the file unchanged and is told the same
thing again until the run stalls. The message names the opener that was never
closed, and the closer to add.

## Stacks

A run builds in one of two stacks, fixed by the run that creates the project.

**`react`** (the default) scaffolds `index.html`, `main.js`, `App.js` and
`styles.css` and lets the agent extend them. There is no build step, so React
is loaded through an import map from a pinned CDN and markup is written with
[htm](https://github.com/developit/htm) tagged templates rather than JSX:
`` html`<div>...</div>` ``, with components interpolated as `` <${Name} /> ``
and closed with `<//>`. Every in-browser JSX transform was tried first and none
of them works here — an external `type="text/babel"` script is ignored outright,
and the inline form resolves relative imports against a synthetic base, so
multi-file JSX is impossible. htm has none of those problems.

The entry point is deliberately scaffolded rather than generated: a slightly
wrong import map renders a blank page with no readable error anywhere.

**`static`** is plain HTML, CSS and JavaScript with no framework at all.

## Building something bigger than one page

Anything past a single file gets built by asking repeatedly, so runs are grouped
into a **project**:

- the first run creates one and the UI shows its id;
- every later run continues it, seeing and extending the files already there;
- **New project** starts an empty one.

**Effort** sets the iteration ceiling for a run. Raise it for work that needs
several files; the run stops at the limit with `budget_exceeded` rather than
spending without bound.

The preview pane renders the project from
`GET /api/projects/{id}/site/t/{preview_token}/{path}`, so relative
`styles.css`, `app.js` and page links resolve the way they will in a browser —
and, because the credential is a path prefix rather than a query parameter,
every one of those subresources stays authenticated instead of 401-ing. It is
served into a sandboxed frame with no `allow-same-origin`, a restrictive CSP,
`nosniff` and an explicit media-type allow-list: model-authored bytes are never
sniffed. That sandbox puts the frame on a `null` origin, and ES module scripts
are always fetched in CORS mode, so these responses carry
`Access-Control-Allow-Origin: *`; they are anonymous, authorised only by the
unguessable signed token in the path, never by a cookie or bearer header.

### Reading is not progress

An agent that reads, searches and reads again never trips a budget — every
iteration succeeds — and simply arrives at the end of the run with nothing
written. The loop counts consecutive read-only calls, tells the agent when it is
circling, and stops the run if it keeps going, with a summary that names the
real problem rather than "budget exceeded".

## What the panes show

- **Activity** — the run's actual audit records, rendered legibly. Each line
  keeps the raw event type next to it, so the screen can always be reconciled
  with the audit log.
- **Files** — what the run produced, readable as it lands.
- **Status bar** — iterations and credits spent, which is the cost half of the
  platform's north-star metric.
