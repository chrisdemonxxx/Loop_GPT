# P1 CLOSEOUT — `ops-release`: the binary layer is on the box, and the harness smoke is green

to: `hr-bot` (role cards) · `boss-bot` (plan/wrapper) · cc: `research-scout`   from: `ops-release`
2026-09-28   plan: `team/PHASES_PENTEST.md` §4 (P1)   board: kanban `offense`, card `t_a3272e9f`

**Status: P1 CLOSED.** Two commits in the engagement repo (`projects/development/offense-fleet`):
`82e18d4` (the tool layer) and `883e973` (PATH.sh precedence + `tools/README.md`). Nothing outside
`tools/` was touched — `SOC/` still reads **67** placeholders, i.e. exactly as P0 measured it.

| artifact | bytes | sha256 |
|---|---|---|
| `tools/VERSIONS.md` (`82e18d4`) | 8,344 | `2dfcf99edf9c747f7206ff342b98b7496bcf96bdc8e51cb18d61d4072f6b4a21` |
| `tools/PATH.sh` (`883e973`) | 2,015 | `06a4710659da6cb2e227abac063e7e5cfe6b784033f447e202db4bb7788a99ef` |
| `tools/bin/httpx.exe` (`82e18d4`) | 68,991,488 | `127969918c8c5c600f5ec7b3699fead4f5e4691dcd75a4a0c6f53f4ea9248a75` |
| `tools/README.md` (`883e973`) | 1,680 | `c4d491f8846490b37542252e209ef06476efd6e44a87ae89da6efb16282ce26c` |

All four are **LF by bytes** (`wc -c` == `tr -d '\r' | wc -c` on each text file; `.gitattributes`
`* -text` holds).

## 1. The deliverable — the pinned set, on a durable path

`tools/VERSIONS.md` carries 15 rows: `<name> | <version> | <bytes> | <sha256|go-mod@ver> |
<absolute path>`. Durable root: **`C:\Users\chris\go\bin`** (`%USERPROFILE%\go\bin` — the box's
`GOBIN`, already on the user `PATH`; `research-scout`'s scratch `%LOCALAPPDATA%\Temp\recon-bin` is
no longer needed).

```
$ export GOBIN="C:/Users/chris/go/bin"
$ go install github.com/projectdiscovery/{subfinder/v2/cmd/subfinder,dnsx/cmd/dnsx,httpx/cmd/httpx,
    katana/cmd/katana,nuclei/v3/cmd/nuclei,tlsx/cmd/tlsx,naabu/v2/cmd/naabu}@latest \
    github.com/ffuf/ffuf/v2@latest                      # exit=0 each
$ sha256sum subfinder.exe dnsx.exe httpx.exe katana.exe nuclei.exe tlsx.exe naabu.exe ffuf.exe
661de48d3f5eabc5f881fd40cf68fe460bc356be4d52f4059246e585f785e241 *subfinder.exe
1ee4ce0ae6963c64b1ddc5d7ae4987f3d3cbcddb0aed274e3d6e8d2b761ddf2b *dnsx.exe
127969918c8c5c600f5ec7b3699fead4f5e4691dcd75a4a0c6f53f4ea9248a75 *httpx.exe
2b417ec3566a190d5c311d940f66a70ab3e950af95274498b3d2608b54bc9839 *katana.exe
6fd1276ce1b3ddc4cdfe96f090eba85b693b1792b5ac6bc5c7d340d2965d5cc5 *nuclei.exe
6af50cdc40f1af1470c1ffdeb252bec3661100accd22dc74d469a5330278a79c *tlsx.exe
447cada51a056b8d1a4b447db0c3888f399a675bdb77b9b115d7d2ad6eb7857c *naabu.exe
89cc34511fa37329174c75edbb2b0be7bf34e248c9f7d64090c5fac0a720e4ce *ffuf.exe
```

**All eight match `team/PENTEST_RECON.md` §2 byte-for-byte** — a `@latest` re-install at 08:1xZ
reproduced the 06:2xZ build's hashes exactly. `go version -m` on the durable copies pins the module
versions (`go-mod@github.com/projectdiscovery/httpx@v1.12.0`, …, `github.com/ffuf/ffuf/v2@v2.3.0`);
one deliberate mismatch to record: `ffuf -V` prints `2.1.0-dev` (banner) while its module is
`v2.3.0` — both are in the file.

Non-Go rows, each installed and verified this pass:

```
$ curl -fsSL -o "%USERPROFILE%\go\bin\jq.exe" \
    https://github.com/jqlang/jq/releases/latest/download/jq-windows-amd64.exe   # exit=0
$ ./jq.exe --version            ->  jq-1.8.2
$ sha256sum jq.exe              ->  a6fc67fedaf9128a3309a1e2ebb8b986aeccf70122ee46d2cb4849e423f0c627

$ curl -fsSL https://nmap.org/dist/sigs/nmap-7.991-setup.exe.digest.txt
nmap-7.991-setup.exe: SHA256 = 93BFD37B DB31A7AD FD932BEB 5DBCE060 25DA691D 01A0939E 806EA704 F7367657
$ python dl_nmap_par.py          # 8 parallel range requests, 37,378,768 B
$ sha256sum nmap-7.991-setup.exe -> 93bfd37bdb31a7adfd932beb5dbce06025da691d01a0939e806ea704f7367657
$ "7z" x nmap-7.991-setup.exe -o<nmapx>        # NSIS payload, no admin, no Npcap driver
$ nmap --version
WARNING: Could not import all necessary Npcap functions. … Resorting to connect() mode
Nmap version 7.991 ( https://nmap.org )
$ nmap -Pn -sT -p 8099,8098 127.0.0.1
8098/tcp closed unknown / 8099/tcp open   unknown      Nmap done: 1 IP address … 0.04 seconds
```

The `-Pn -sT` (unprivileged) shape is the lane's; `-sS` / `naabu -s s` stay **UNVERIFIED** with
Npcap absent. `nmap` is a *tree* (1729 files, `nmap-services` sha
`6017b72e5e4194b0904ac9a0bd8a1bbfe790a6ee9953da08ed1bf1eaf8307176`), so it lives flat in
`go\bin\` where `nmap.exe` finds its data; `zenmap/` and the NSIS `$PLUGINSDIR/` were pruned.
`whatweb` is the one dropped row (plan §4a; measured here: no `ruby`/`gem` on the box at all).
`sqlmap 1.10.9#pip` and `python 3.11.15` (the harness's interpreter) are pinned with paths.

## 2. The collision, settled by path (not by luck)

Measured in a fresh shell — the fix was **not** to shadow the name: `...hermes-agent\venv\Scripts`
sits at user-PATH position 19 and `%USERPROFILE%\go\bin` at 56, so bare `httpx` is still the
**Python** CLI after the install:

```
$ command -v httpx      ->  …\hermes-agent\venv\Scripts\httpx        (Usage: httpx [OPTIONS] URL)
```

Three things close it: the absolute path in `tools/VERSIONS.md`; the scaffold's `tools/PATH.sh`
(durable root + `tools/bin` first); and `tools/bin/httpx.exe` — a **byte-identical copy**
(sha `1279699…`), which is what `bin/offense doctor` resolves as `PRESENT (engagement-local)`.

```
$ bash <eng>/tools/PATH.sh  # the card's two source lines
PATH head: <scaffold>/tools/bin : C:/Users/chris/go/bin : …
-- httpx --  tools/bin/httpx        [INF] Current Version: v1.12.0
-- nmap  --  C:\Users\chris\go\bin\nmap   Nmap version 7.991
-- jq    --  jq-1.8.2      -- tlsx -- [INF] Current version: v1.4.0
```

`tools/README.md` now records the durable root and the shim, because it is the file a seat reads
first.

## 3. The harness smoke gate — re-run, on this box, this pass (green)

Scratch tree `%LOCALAPPDATA%\Temp\eh-p1` (a copy of the scaffold's `SOC/`, `findings/`,
`evidence/README.md` — the scaffold tree itself is untouched on purpose, see §5), against a local
`python -m http.server 8099`:

```
$ bash <skill>/scripts/evidence_harness.sh A smoke evidence --target 127.0.0.1 --tool 'curl 8.21.0' \
      -- curl -sS -o .body -w 'HTTP=%{http_code} bytes=%{size_download}\n' http://127.0.0.1:8099/
evidence/phase_A_smoke.md  ## RAW-1  exit=0  sha256=bf1716f185ae7881
$ bash <skill>/scripts/evidence_harness.sh A smoke evidence --target 127.0.0.1 --tool 'curl 8.21.0' \
      -- curl -sS -D - -o .body http://127.0.0.1:8099/
evidence/phase_A_smoke.md  ## RAW-2  exit=0  sha256=fe6a1f65e59511b6
$ grep -c '^## RAW-' evidence/phase_A_smoke.md                -> 2   (RAW-1, RAW-2)
$ python evidence.py seal  --root .   -> sealed over 8 files
$ python evidence.py check --root .   -> OK  8 files covered, 0 mismatched, 0 uncovered, 0 absent
$ sha256sum -c reports/evidence_manifest.sha256              -> 8x "OK", exit=0
$ <byte check>  evidence/phase_A_smoke.md 1049 B CR=0; reports/evidence_manifest.sha256 743 B CR=0
```

RAW-2's body is the real proof (`HTTP/1.0 200 OK … Content-Length: 347`). RAW-1 is kept, not
tidied, because it caught a **harness defect** worth knowing (§6). The count is the verdict, and the
count is `records=2`, `OK == rows = 8`.

## 4. The box moved under us: the resolver is no longer `10.64.0.1`

`team/PENTEST_RECON.md` §3 and `offensive/offensive-recon` §1 both say "pass `-r <the box resolver>`,
which is `10.64.0.1`". Re-measured at 08:5xZ, the box resolver is **Cloudflare**, the tools'
**defaults now work**, and the old pin is dead in exactly the silent-empty way the defaults used to be:

```
$ nslookup example.com            ->  Server: one.one.one.one   Address: 2606:4700:4700::1111
$ echo example.com | dnsx -a -resp -silent                    -> 2 A records        exit=0
$ echo example.com | dnsx -a -resp -silent -r 1.1.1.1         -> 2 A records        exit=0
$ echo example.com | dnsx -a -resp -silent -r 10.64.0.1       -> [WRN] 1 domains failed to resolve  exit=0
$ httpx -u https://loop-gpt.cyou -sc -title -server -silent    -> [200] [Loop GPT - AI Chat Assistant] [railway-hikari]
$ tlsx  -u loop-gpt.cyou -cn -silent -r 1.1.1.1               -> loop-gpt.cyou:443 [loop-gpt.cyou]
$ naabu -host loop-gpt.cyou -top-ports 100 -silent            -> 80, 443            exit=0
$ naabu -host loop-gpt.cyou -top-ports 100 -silent -r 10.64.0.1 -> [FTL] no valid ipv4 or ipv6 targets  exit=1
```

**The rule is the shape, not the constant.** Handing back: `hr-bot` should re-word
`offensive-recon` §1 / the role cards to "read the resolver at lane start (`nslookup` → `Server:`),
pass that; and treat zero records as a resolver failure until a `-r` re-run and a default re-run both
disagree"; `research-scout`/`boss-bot` should correct `PENTEST_RECON.md` §3, which now reads as
current and is stale. A lane that hard-codes `10.64.0.1` today gets four silent-empty tools.

## 5. Handback to `hr-bot` — the paths for the role cards

| lane | binary → absolute path |
|---|---|
| `recon-passive` | `C:\Users\chris\go\bin\dnsx.exe`, `…\subfinder.exe`, `…\tlsx.exe` |
| `recon-active` | `C:\Users\chris\go\bin\naabu.exe`, `…\nmap.exe`, `…\nuclei.exe` |
| `web-cartographer` | **`C:\Users\chris\go\bin\httpx.exe`** (pd), `…\katana.exe`, `…\tlsx.exe` |
| `input-fuzzer` | `C:\Users\chris\go\bin\ffuf.exe`, `…\sqlmap.exe`† |
| `api-dataflow` | **`C:\Users\chris\go\bin\httpx.exe`** (pd), `…\tlsx.exe`, openssl (PATH) |
| `exploit-op` | `C:\Users\chris\go\bin\sqlmap.exe`†, `…\nuclei.exe` |
| all | `nuclei -templates-version` → `v10.4.9` at `C:\Users\chris\nuclei-templates`; python `3.11.15`; `jq` at `…\go\bin\jq.exe` |

† `sqlmap` is the pip wrapper `…\Programs\Python\Python312\Scripts\sqlmap.exe` (still the box's, not
re-installed). Nothing in the fleet needs a re-pin: the durable root is the box's `GOBIN`, which is
already on the user `PATH`; a seat resolves the set by name, and `httpx` by path.

## 6. Handback to `boss-bot` — the wrapper, and one measured drift

`bin/offense doctor` is the P1 acceptance read-back, before and after this card (both raw):

```
before:  binaries  MISS 4/5 on box  httpx=AMBIGUOUS   (web-cartographer, api-dataflow)
         counts: profile 8/8 model 8/8 skill 8/8 mcp 8/8 toolset 8/8 bin 6/8  TOTAL 46/48
after:   PRESENT   httpx   …\offense-fleet\tools\bin\httpx.exe  (engagement-local)
         counts: … connector 8/8 bin 8/8  TOTAL 56/56
```

(the `connector` category appeared between the two runs — `bin/offense.py` is being edited in a
live session while this card runs; the file is `M` in the working tree, so it is untouched by my
commits.)

Four things for you, all measured, none of them mine to change:

1. **`hotspot: bin/offense.py`** (and `bin/offense`) — modified in the working tree by another
   session during this card; `bin/__pycache__/` is untracked and deserves a `.gitignore` line.
2. **The `pd-abs` probe reads the banner.** `tool_status()` judges httpx on `txt[0]`, which for a
   projectdiscovery binary is ASCII art (`'__    __  __       _  __'`), so a *correct* pd-`httpx`
   on `PATH` is reported `AMBIGUOUS` — the scaffold's `tools/bin` copy is what makes it `PRESENT`.
   Scan the whole output for `projectdiscovery|Current Version` and the verdict is right in both
   cases. (`fleet.json`'s note names `$HTTPX_PD`, which the code never reads.)
3. **`fleet.json.plan_sha256` is stale.** It pins `373fd37e2377…`, the file now hashes
   `36bbbc855089022f1118c5535309a01a21e2be15e299b8c8e398c00ba910c781`; `doctor` prints the pin but
   never verifies it, so the drift is silent.
4. **`bin/offense.py`'s shim** (agrees with `team/RESEARCH_sandbox_tools_path.md` §1/§2): `$ENG` is
   derived from the tools dir, so it prepends `<eng>/tools/tools/bin`, and `$SCAFFOLD_TOOLS_BIN` is
   empty in a seat's shell (an empty PATH element = CWD). My `tools/PATH.sh` defines the variable
   and prepends the durable root, so a fresh sandbox resolves the pins **today**; the one-line fix in
   `provision` is still yours if you want the shim's own two entries correct.

## 7. Not done here (P3, still owed by `ops-release` + `perf-eng`)

`bin/offense run <ENG-ID> --target <t>` exists now (yours, `56241a2`). The P3 acceptance — two runs
into two dirs, `diff -r` of the two `findings/` empty, wall-clock + per-phase timings into
`team/PERF_OFFENSE.md` — has not been run. It is a separate card; the tool layer it needs is this
one.

**Acceptance, verbatim, and where it is met:** `nuclei -version && nmap --version && ffuf -V &&
subfinder -version` print (§1); `tools/VERSIONS.md` is pinned from `team/PENTEST_RECON.md` §2 with
one line per binary, a missing field nowhere (§1); every seat resolves pd-`httpx` by absolute path
(§2, §5); the `evidence-harness` smoke writes an evidence file with `## RAW-1` (and RAW-2) and
appends its sha256, judged on counts (§3).
