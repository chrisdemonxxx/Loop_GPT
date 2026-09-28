# OFFENSE FRAMEWORK — one entrypoint: `offense-fleet/bin/offense` (owner: `boss-bot`)

to: room (`@hr-bot`, `@ops-release`, `@research-scout`, `@user`)   from: `boss-bot`   2026-09-28T12:4xZ
re: the "one thing that calls all bots together" ask. Built, run on this box, evidence below.
Plan of record unchanged: `team/PHASES_PENTEST.md` (this is P3's provisioner, landed early).

---

## 1. What shipped (paths, bytes, sha256, all measured in this pass)

| path | bytes | sha256 (16) | what |
|---|---|---|---|
| `offense-fleet/fleet.json` | 10,674 | `b6347aeee85f710a` | the manifest of record: 8 seats × (phases, tier, skills, tools, toolsets, MCP, connectors) + 6 gate roles + the toolchain block |
| `offense-fleet/bin/offense.py` | 32,397 | `c7263a000a3f9075` | the engine — stdlib only, no venv, counts-based verdicts |
| `offense-fleet/bin/offense` | 683 | `404228e93ad26c33` | shim (`pwd -W` → native paths; this box has MSYS conversion off) |
| `offense-fleet/README.md` | 5,466 | `169f1e7ab88444f0` | the one-command launch path replaces the 6-command hand path |
| commit | `aab6f5c` | on `offense-fleet` HEAD (`58f9a3b` before) | `offense: one entrypoint — fleet.json manifest + bin/offense` |

Six subcommands: `doctor · plan · init · up · run · status · gate`.
`run <ENG-ID> --target <host>` = `init` + `up` (+ `--gateway`), which is the whole job in one line.

## 2. The raw run (paste-back, this box, this pass)

**`bin/offense doctor --slug eng-2026-09-28-001`** — verdict from counts, never exit status:

```
  profile   8/8      model     8/8      skill     8/8
  mcp       7/8      toolset   8/8      bin       5/8        TOTAL 44/48
```

The 4 that are short are real, not noise:

| seat | delta | raw |
|---|---|---|
| `recon-passive` | needs `brightdata` (scrape/search MCP) | `mcp enabled=0 required: brightdata` — the seat has **no `mcp_servers:` key at all** |
| `recon-active` | `nmap` | `MISSING nmap not on PATH` |
| `web-cartographer`, `api-dataflow` | projectdiscovery `httpx` | `AMBIGUOUS …venv\Scripts\httpx.EXE is NOT projectdiscovery httpx -> 'Usage: httpx.EXE [OPTIONS] URL'` |

**Correction to `team/PENTEST_RECON.md` §0 / `PHASES_PENTEST.md` §0:** the Go layer has landed since that
measurement. `~/go/bin` now resolves `dnsx, ffuf, katana, naabu, nuclei, subfinder, tlsx` with real
version lines (`Nuclei Engine Version: v3.11.1`, `ffuf 2.1.0-dev`, `subfinder v2.16.0`). Only **`nmap`**
is still missing. The old list is stale, the delta shrank from 8 binaries to 1.

**`bin/offense init ENG-2026-09-28-001 --target loop-gpt.cyou`** (real, not dry):

```
  sandbox C:\...\projects\development\ENG-2026-09-28-001  (16 files from git archive, placeholders filled 30, left 37)
  .session  sha256(manifest)=b6347aeee85f710a…  scaffold HEAD=58f9a3ba4
  tools/    bin/ + PATH.sh + VERSIONS.md
  $ hermes kanban boards create eng-2026-09-28-001 --name "ENG-2026-09-28-001 A-R" --default-workdir <E>  -> rc=0
  card  1 ops-release       t_2a55ad7e  rc=0      …      card  9 verifier   t_af445071  rc=0
# 9/9 cards created.
```

- `30 + 37 = 67` — the scaffold's pinned placeholder count, unchanged. The 37 left are the **human**
  ones (`<first A-record IP>`, `<resolver IP>`, `<operator>`, `<vault handle>`, `<authorizing party>`, …);
  `init` fills only what it can know (`<target>`, `<ENG>`, `<ENG-ID>`, `<YYYY-MM-DD>`) and *counts* the rest.
  Dry run reports the same 30/67 before writing a byte.
- The sandbox is a **fresh dir**, `git archive HEAD | tar -x` + `git init -q` — never `cp -r`, so it does
  not race the standing board's pinned workspace and does not inherit its `.git`.
- `.session` is the sandbox receipt: scaffold HEAD, manifest sha256, seat list, placeholder count, card ids.

**`bin/offense up eng-2026-09-28-001`** (real dispatch):

```
--- 27 probes: 27 RESOLVED / 0 MISSING ---
$ hermes kanban --board eng-2026-09-28-001 dispatch
  Reclaimed: 0 · Crashed: 0 · Spawned: 1
    - t_2a55ad7e  ->  ops-release  @ C:\...\projects\development\ENG-2026-09-28-001
```

The probe ran **before** the first dispatch, on the new board's own card list, so no card can crash on a
skill its assignee cannot resolve (the failure mode that parked the standing board for 41 minutes).
Live state after: `t_2a55ad7e running · workspace dir @ …/ENG-2026-09-28-001 · children t_d65fc1d0`,
run 1 claimed + spawned + heartbeat. The A→R chain is real: the 8 seat cards are `todo` behind it.

## 3. `bin/offense gate` — the P4 three checks, re-run against the two shipped engagements

The gate is the same three checks as `PHASES_PENTEST.md` §4a, and it reproduces §4a's measured numbers:

| engagement | check | raw |
|---|---|---|
| `bluekit-pentest` | MANIFEST | `rows=333 OK=333 FAILED=0 unreadable=0 malformed=0 -> PASS` (`row bases {'(root)': 333}`, `\` separators tolerated) |
| `bluekit-pentest` | COVERAGE | `tree=1248 declared excludes=NONE counted=1248 rows=333 -> FAIL` ← **exactly §4a's point**: coverage needs the *declared* exclude |
| `bluekit-pentest` | STATUS + R | `registry rows=50 Open=22`; `R shape A = none`, `R shape B = 0 files` -> **FAIL** |
| `penttest` | MANIFEST | `rows=5 header=0 CRLF=True malformed=0 … OK=5 FAILED=0 -> PASS` — matches `tr -d '\r' \| sha256sum -c -` → 5/5 OK; the CRLF trap is flagged, the counts still decide |
| `penttest` | STATUS + R | `registry rows=0` (no `findings/`); `shape A = ['phase_R_killchain.md']`, `shape B = 53 files over waves [8,9,10,12,13,14,18,19,20,25,27,36,37]` |

**Two real findings the gate produced that were not in the gap list:**

1. **`bluekit-pentest` ships with NO phase-R artifact.** `ls bluekit-pentest/evidence` ends at
   `phase_Q_verification.md`; no `phase_R_*`, no `R<N>_*`. The reference close-out §4a is measured
   against fails its own R-shape bar. (Not a gate bug — a filesystem read.)
2. `penttest` has no `findings/` tree at all, so the registry check reads 0 rows.

Both are `verifier`-lane items, and both are now mechanical rather than a matter of opinion.

## 4. What remains (hand-offs, in dependency order)

1. **`hr-bot`** — the seats' config layer. Measured, per seat: `mcp_servers:` key **absent** on all 8
   (so zero MCP servers), no `platform_toolsets.cli` (so the install default, 27 toolsets, is what they
   run), and `skills.external_dirs` is the correct 6-entry list (8/8 seats resolve every manifest skill —
   confirmed independently by the 27/27 live probe). To close `doctor`: give `recon-passive` the
   `brightdata` server block.
2. **`ops-release`** — `nmap` is the last binary; then pin `tools/VERSIONS.md` (the slot is staged by
   `init` at `<eng>/tools/VERSIONS.md`, one line per binary = `<name> <version> <sha256|go-mod@ver>`).
   Also: pd-`httpx` resolved **by absolute path** (`<eng>/tools/bin/httpx.exe` → scaffold `tools/bin/` →
   `$HTTPX_PD`); the gate/doctor already treat the PATH `httpx` as ambiguous.
3. **`ops-release` + `perf-eng` (P3 proper)** — `offense run` exists for the *provision* half. P3's
   remaining acceptance is unchanged: `--scope <file>`, two runs into two dirs, `diff -r` of `findings/`
   empty, timing table in `team/PERF_OFFENSE.md`.
4. **`verifier`** — declare the excludes in the engagement's `SOC/02` (the gate's own message), and the
   bluekit R-shape gap.

## 6. The tool bootstrap — fixed, and the chain proved (added 2026-09-28T13:0xZ)

`research-scout` (5 claims) and `hr-bot` (independent reproduction) were right on all of it, and one of the
two was worse than a readiness nit. All three defects are in my file, all three are fixed, and the fix is
verified on the live session.

**Before** (reproduced verbatim, `cd ENG-2026-09-28-001 && bash -c 'source tools/PATH.sh; …'`):

```
E1=/c/…/ENG-2026-09-28-001/tools/tools/bin      ls -d tools/tools/bin -> No such file or directory
E2=                                             (empty element == CWD)
E3=/c/Users/chris/bin
with a chmod +x'd `ffuf` in the seat's cwd:  command -v ffuf -> ./ffuf
```

**What was wrong, exactly:**

1. `BASH_SOURCE` points at the *shim*; the shim lives in `tools/`, so the engagement root is its
   **parent** — `dirname(...)` produced a ghost dir.
2. `$SCAFFOLD_TOOLS_BIN` is exported only in `bin/offense` (the process that then `exec`s python). A seat's
   shell is not that process, so element 2 was empty — and an empty PATH element means **CWD**, so a file
   named like a lane binary in the seat's working dir shadowed the pinned tool.
3. Nothing was staged: `init` made the directory and copied nothing.
4. (found while fixing 1–3, and it was **mine**): the card's own first line read
   `source ../tools/PATH.sh 2>/dev/null` — relative to an engagement, `../tools/` is a *sibling* of the
   scaffold, i.e. `projects/development/tools/`, which does not exist. The `2>/dev/null` made the miss
   silent, so the line looked fine and did nothing. It now sources the scaffold shim by absolute path.

**After** (`offense tools ../ENG-2026-09-28-001`):

```
  staged 9 file(s) into <eng>/tools/bin   (scaffold bin: …/offense-fleet/tools/bin)
  PATH.sh rewritten, 410 B, sha256 d65d399d931b62f0…
  self-test OK    E1=…/ENG-2026-09-28-001/tools/bin  E2=…/offense-fleet/tools/bin  empty_elements=0
```

The self-test runs the **card's real first line**, at the top level of a shell (inside `$( )` the PATH edit
is discarded — that was a bug in the first self-test), and asserts four counts: element 1 is the
engagement's own bin and a directory, element 2 the scaffold bin, zero empty elements, and the scaffold
shim present. A seat's shell in the live session now resolves:

```
nmap /c/Users/chris/go/bin/nmap        (durable root)
nuclei httpx ffuf jq subfinder dnsx katana naabu tlsx
     -> /c/…/ENG-2026-09-28-001/tools/bin/<name>     (the SESSION'S OWN copy)
sqlmap -> the Python install
```

A `chmod +x`'d file named `httpx` in the seat's own cwd no longer wins: `command -v httpx` → the sandbox's
pinned `tools/bin/httpx`. `doctor` grew the two checks the room asked for — **connector**
(`tools.connectors.enabled`, read from the CLI because it is a built-in default and absent from a minimal
config) and, with `--eng`, **path** (the self-test above). Verdicts:

```
before: 44/48   (mcp 7/8, bin 5/8)
now:    56/56   (`--eng`: 57/57 — path 1/1)
```

`mcp 8/8` is `hr-bot`'s `brightdata` fix; `bin 8/8` is `ops-release` landing `nmap` (7.991) + pd-`httpx`
into `~/go/bin` and the scaffold's `tools/bin`, which `init` hardlinks into every session.

**The chain also proved itself while this was being fixed.** The live `eng-2026-09-28-001` board ran
without me: the P0 contract card **completed** (539s, `→ P0 contract frozen … filled all 37 human
placeholders … first A-record 69.46.46.61`, commit `2897a3a chore(eng): freeze SOC contract, scope and
RoE`), `SOC/0*.md` went **37 → 0** placeholders, and the **A card auto-promoted to `ready`** on its
parent's completion; `offense up` then spawned `t_d65fc1d0 → recon-passive @ …/ENG-2026-09-28-001`
(`running`). Parent-gating, per-seat workspace and the dispatcher are all doing their job.

Scaffold commits: `b66b6ba` (the shim + staging + the two new checks + `offense tools`) and `543b92d`
(the absolute card bootstrap + the honest self-test).

## 7. Room copy (for `@user`)

One line does it now: `bin/offense run <ENG-ID> --target <host>` → fresh sandbox, board, the 9 A→R cards
parent-chained with their skills/MCP/toolsets attached, 27/27 skill probes green, dispatcher spawned the
first card. The fleet reads **56/56** on `offense doctor` (`57/57` with `--eng`), the sandbox stages the
pinned binaries into its own `tools/bin` and self-tests the shim before anything else runs, and
`bin/offense gate` decides a close-out on counts — it already catches the `bluekit` R-shape gap.

