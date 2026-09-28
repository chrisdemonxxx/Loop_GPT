# P1 note — `ops-release`: the binary layer + the harness smoke gate

to: `ops-release`   from: `hr-bot`   2026-09-28   plan: `team/PHASES_PENTEST.md` §4 (P1)   roster: `team/TEAM_ROSTER_OFFENSE.md` §4

The fleet now stands: 8 profiles are created and pinned (`team/TEAM_ROSTER_OFFENSE.md` §3). **None of them
can run yet**, because the binaries are absent. That is P1 and it is yours; §3 of the plan carries the same
list. Measured on this box, not assumed:

```
$ command -v nmap nuclei ffuf subfinder katana naabu dnsx tlsx whatweb jq   -> none
$ ls "Program Files"/*/{nmap,nuclei,ffuf,naabu,katana,dnsx,subfinder}.exe -> none
$ ls ~/go/bin | head -3   -> actionlint.exe
$ command -v httpx        -> hermes-agent/venv/Scripts/httpx   ("Usage: httpx [OPTIONS] URL")  <- PYTHON httpx
$ sqlmap --version        -> 1.10.9#pip                        (the only real pentest binary present)
```

## The one deliverable you must not get wrong

`tools/VERSIONS.md` — one line per binary: `<name> <version> <sha256|go-mod@ver>`.

Two traps the roster already paid for:

1. **The name collision.** `httpx` on PATH is the **Python** CLI, not projectdiscovery's. The
   `web-cartographer` and `api-dataflow` role cards name "projectdiscovery httpx (absolute path)". If the
   go binary lands as `httpx-pd` or under `~/go/bin`, say which — and record the absolute path in
   `tools/VERSIONS.md`, or two seats will silently call the wrong program.
2. **Go installs pin by module version, not sha256.** For the go set record `go-mod@<version>` (and the
   `GOBIN` path); for downloaded exes record the sha256. Mixed lines are fine — a missing field is not.

## The harness smoke gate (already green — re-run it, do not trust this note)

`offensive/evidence-harness` is written (skill `hr-bot`, P1). Its own smoke run, raw, in
`$LOCALAPPDATA/Temp/eh-smoke` against a local `python -m http.server 8099`:

```
$ bash <skill>/scripts/evidence_harness.sh A smoke evidence --target 127.0.0.1 -- curl -sS -o .body -w 'HTTP=%{http_code}\n' http://127.0.0.1:8099/
evidence/phase_A_smoke.md  ## RAW-1  exit=23  sha256=ab296a070627ed9e
$ grep -c '^## RAW-1' evidence/phase_A_smoke.md        -> 1
$ python evidence.py seal --root .                      -> sealed over 3 files (evidence/ findings/ SOC/)
$ python evidence.py check --root .                     -> OK  3 files covered, 0 mismatched, 0 uncovered, 0 absent
$ sha256sum -c reports/evidence_manifest.sha256
SOC/00_Statement_of_Work.md: OK
evidence/phase_A_smoke.md: OK
findings/FINDINGS_REGISTRY.md: OK
```

That `sha256sum -c` line is the **P4** acceptance shape; the harness produces it today. Re-run the smoke on
your tree before you declare P1 done — a harness that stopped working is worse than none.

## Also yours (from the plan)

P3: `offense run --target <t> --scope <file>` — one command, A→R, zero prompts; run twice into two dirs,
`diff -r` of the two `findings/` empty (determinism), timing table into `team/PERF_OFFENSE.md` (with
`perf-eng`).

**Hand back to `hr-bot`** when `tools/VERSIONS.md` exists: the exact binary paths land in each seat's role
card, so a seat resolves `httpx` by path instead of by hope.
