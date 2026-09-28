# RESEARCH — "fresh sandbox, all tools pre-ready": the tool bootstrap is inert (owner of claim: `research-scout`)

to: `boss-bot` (framework owner)  cc: `ops-release` (bin lane)  from: `research-scout`  2026-09-28
lane: external / live-artifact ground truth on the user's clause "sandbox freshly designated for every
new session with all tools pre ready." Verified by probe, not by reading the manifest's intent.

Artifacts under probe (hashes, live):
- `offense-fleet/bin/offense.py` sha256 `c7263a000a3f9075c183e861a3fcd0e930f090eb4b877564f4be7ba2a7218f2a` (32,397 B, fleet HEAD `56241a2`)
- generated `ENG-2026-09-28-001/tools/PATH.sh` sha256 `5bf24309166991509dcc9b141f746240fd228da81a8cdb27e69896c67a8f93e8` (the file a seat sources first)

## Claims (one per line, raw beside each, confidence)

1. **A card's first line resolves to a nonexistent PATH entry.** The card body is `source tools/PATH.sh`
   (`bin/offense.py:273`); `PATH.sh` derives `ENG` from `dirname(BASH_SOURCE[0])` = `tools`, then
   prepends `$ENG/tools/bin` → `<eng>/tools/tools/bin`. Raw, sourced exactly as the card does it:
   `cd ENG-2026-09-28-001 && bash -c 'source tools/PATH.sh; echo $PATH|cut -d: -f1'`
   → `/c/…/ENG-2026-09-28-001/tools/tools/bin`; `ls -d tools/tools/bin` → **does not exist**; the real
   `tools/bin` is a sibling and is never on PATH. CONFIDENCE: high (reproduced).
2. **The scaffold tier expands to empty in the seat's shell.** `$SCAFFOLD_TOOLS_BIN` is `export`ed in
   exactly one place — `offense-fleet/bin/offense:12` (`SCAFFOLD_TOOLS_BIN="$SCAF_W/tools/bin"`), the
   wrapper that then `exec`s python. The seat's shell is not that process, so the shim's second element
   is the empty string. Raw: same probe, `cut -d: -f2` → *(blank)*. CONFIDENCE: high.
3. **An empty PATH element = CWD.** With `SCAFFOLD_TOOLS_BIN` unset the line is
   `export PATH="$ENG/tools/bin:$SCAFFOLD_TOOLS_BIN:$PATH"` → `…:…::…`; a POSIX empty element means the
   current directory, so a tool named like a file in the seat's cwd shadows PATH. Same raw. CONFIDENCE:
   high (mechanics); not yet observed to bite on this box.
4. **Nothing is staged anyway.** `find offense-fleet/tools -type f` → only `README.md`, `VERSIONS.md`;
   `offense-fleet/tools/bin/` holds no binaries; `init` (`offense.py:387-397`) `mkdir`s `<eng>/tools/bin`
   and writes the shim + a VERSIONS header, copies no binaries. `ls -la ENG-2026-09-28-001/tools/bin/` →
   empty. So "all tools pre-ready" is currently a directory and a shim. CONFIDENCE: high.
5. **The 3 `doctor` bin misses are the box's PATH, not missing software (external probe).**
   `which nmap` → `/c/Users/chris/go/bin/nmap` (present; go-install dir simply not on the host PATH the
   probe inherits). `which httpx` → `C:/Users/chris/AppData/Local/hermes/hermes-agent/venv/Scripts/httpx`
   = the Python CLI (`httpx -version` → `Usage: httpx [OPTIONS] URL`), i.e. the pd-`httpx` *naming*
   collision `hr-bot` reported, not an absent binary. CONFIDENCE: high (raw probes).

## Consequence for the user's clause

Even after `ops-release` lands `nmap` and a pd-`httpx` on the box, a fresh sandbox will **not** have
them "pre-ready": the only pre-ready mechanism (the shim) points at a nonexistent dir (#1) and an
unset variable (#2), and stages nothing (#4). Two fixes, both one-liners in `provision`:
- `PATH.sh`: derive `ENG` from `dirname(BASH_SOURCE[0])/..`, and define `SCAFFOLD_TOOLS_BIN` in the
  shim itself (do not depend on the wrapper's env);
- `init`: link or copy the pinned `tools/bin` into `<eng>/tools/bin` (or point the shim at the scaffold
  bin by absolute path), so a new session is ready without a human step.

UNVERIFIED: whether a seat spawned by `kanban dispatch` inherits any environment that re-defines
`SCAFFOLD_TOOLS_BIN` (not chased into the dispatcher's spawn path — `hermes kanban … dispatch`).
If it does, #2/#3 soften but #1 and #4 stand.

---

# ROUND 2 — the clause now HOLDS, verified on a brand-new sandbox (fleet HEAD `543b92d`)

All four defects were reproduced independently (`hr-bot`) and fixed by `boss-bot` in `b66b6ba` + `543b92d`.
Re-verified on a **new** session, not the hand-rehydrated one: reproduced `provision()`'s exact
scaffold step into a scratch dir, then ran only the staging + shim half (`provision()` line 502,
`stage_tools`), with no kanban side effects:

```
$ git archive HEAD | tar -x -C <scratch> ; git -C <scratch> init -q
$ find <scratch>/tools/bin -type f | wc -l     -> 1        # httpx.exe (the one tracked binary)
$ bash bin/offense tools <scratch>
  staged 9 file(s) into <eng>/tools/bin
  PATH.sh rewritten, 410 B, sha256 d65d399d931b62f0…
  self-test OK   E1=<scratch>/tools/bin   E2=…/offense-fleet/tools/bin   empty_elements=0
$ # the card's real first line, in that fresh sandbox, nothing hand-run:
  empty_elements= 0
  nmap      -> /c/Users/chris/go/bin/nmap                       # the tree, from the durable root (by design)
  nuclei httpx ffuf jq subfinder dnsx katana naabu tlsx
            -> <scratch>/tools/bin/<name>                      # 9/9 session-local
```

Identity, not just presence (a `command -v` can be a lie):
- staged `nuclei.exe` and `C:\Users\chris\go\bin\nuclei.exe` share inode `17732923532813014` → a real
  hard link (nlink 4), not a copy. CONFIDENCE: high.
- staged `httpx.exe` → `Current Version: v1.12.0` = the `VERSIONS.md` pin (projectdiscovery, not the
  Python CLI). Independent copy (inode `2814749770196160`, nlink 1) because it is the one binary
  tracked in git and extracted by `tar`; the pd/Python collision is resolved *at the session tier* even
  though bare `httpx` on the box PATH is still the Python CLI. CONFIDENCE: high.
- `jq.exe` sha256 `a6fc67fe…` == the pin in `tools/VERSIONS.md`. CONFIDENCE: high.

## Residual — two small items for `ops-release`, neither blocks a session

1. **The readiness is box-local, not portable.** `git ls-files tools/bin` → 1 file (`httpx.exe`); the
   other 8 are git-ignored (`tools/bin/.gitignore`). A fresh `git clone` / second host gives the
   scaffold a `tools/bin` of `httpx.exe` alone, so `stage_tools` links 1 of 9 — the `go-mod@…` rows
   in `VERSIONS.md` are the reinstall recipe. One line in `tools/README.md` makes that a reinstall,
   not a mystery. CONFIDENCE: high.
2. **The one tracked binary has no byte pin.** `VERSIONS.md`'s verify block runs
   `sha256sum "$G/httpx.exe"` and calls a mismatch a P1 regression, but `httpx` is the only `go-mod@`
   row without a `sha256:`. Measured: `sha256sum tools/bin/httpx.exe` →
   `127969918c8c5c600f5ec7b3699fead4f5e4691dcd75a4a0c6f53f4ea9248a75`, recorded nowhere in the
   manifest. The tracked, most-collided binary is the one a reinstall can silently swap. CONFIDENCE: high.

UNVERIFIED: whether `nmap`'s flat tree (`nmap.exe` + `nmap-services` + …) is staged anywhere; measured
`tools/bin` has no `nmap*` and `nmap` resolves from the durable root by PATH, so a session whose shell
lost `go/bin` would lose `nmap` alone (the other 9 are session-local). Not exercised.
