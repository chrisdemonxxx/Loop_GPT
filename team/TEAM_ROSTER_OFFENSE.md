# offense-fleet — TEAM ROSTER (owner: `hr-bot`)

Snapshot: 2026-09-28T13:0xZ · HEAD `629d7f6`+ (branch `release/owned-staging-20260917`; tree carries
scratch files, none of them mine). `doctor` on the live `eng-2026-09-28-001`: **57/57** with `--eng`
(56/56 without). Plan of record: `team/PHASES_PENTEST.md` (`boss-bot`,
sha256 `373fd37e23773469ea4fd9d0b671c45b02ed7a1c154a6eb364e94c5e1419a38e`, 10,388 B) — §3 is the
frozen bot list and tool allowlist this roster is cut from. Nothing here renames a phase: A–R is the
taxonomy as used by `bluekit-pentest` and `penttest`.

**Status: seats are real (created, pinned, tool-capable) — the corpus and the binary layer are not.**
P0-corpus (`research-scout`) and P1-binaries (`ops-release`) are still open; nothing in this file is
gated on them, because §3 froze the bot list before I cut the profiles.

---

## 1. Model inventory — LIVE PROBES (re-run this pass, not carried forward)

`scripts/probe_models.sh <base> <model>` — one request, HTTP status + seconds + the `tool_calls`
entry; exits non-zero unless HTTP 200 **and** a tool call came back. Raw output, 2026-09-28:

```
s-zaizen/DeepSeek-V4.1-Flash-Abliterated  HTTP 200  1.613591s  TOOLS_OK ping{"x": "1"}   EXIT=0
Qwen3.8-27B-Uncensored-Cyber              HTTP 200  4.239440s  TOOLS_OK ping{"x": "1"}   EXIT=0
```

| Provider (`config.yaml` key) | Model | (a) liveness | (b) tools | Verdict |
|---|---|---|---|---|
| `hf-dsv41` | `s-zaizen/DeepSeek-V4.1-Flash-Abliterated` | `200` 1.614s | `TOOLS_OK ping({"x": "1"})` | **LIVE — deep tier** |
| `qwen3-cyber` | `Qwen3.8-27B-Uncensored-Cyber` | `200` 4.239s | `TOOLS_OK ping({"x": "1"})` | **LIVE — fast tier** |

**Still rejected (carried from the fleet roster, `TEAM_ROSTER.md` rev 4; no new endpoint has appeared):**

| Provider key | Model | Probe | Rejected because |
|---|---|---|---|
| `glm52-abliterated` | `zai-org/GLM-5.2` (HF router) | `402` | router credits depleted |
| `lunaris-abliterated` | `Sao10K/L3-8B-Lunaris-v1` (router) | `402` | same account credit wall |
| `glm53-cyber-big` / `glm53-abliterated-big` | `/repository` @ `gaxe6hi6mcx4mtn6…` | `404` | endpoint gone (`Not Found`) |
| `glm53-flash` | `/repository` @ `http://127.0.0.1:8611/v1` | `400 model '/repository' does not exist` | stale local router proxy |
| `foundry-gpt6astra` | `gpt-6-astra-1` (Azure) | `401` | invalid subscription key |
| HF-router group (`Qwen/Qwen3.8-27B`, `deepseek-ai/DeepSeek-V4.1-Flash`, `zai-org/GLM-5.3`, `moonshotai/Kimi-K3`, `openai/gpt-oss-120b`) | — | `402` | `depleted your monthly included credits` |

**Consequence: the fleet has exactly two live worker models, so every seat is pinned inside that pair.**
Both dead blocks are still *present* in the new profiles' `providers:` map (they were cloned from
`ops-release`); they are not pinned by anyone. `qwen3-cyber` is a **scale-to-zero endpoint** with a
`503` cold-start window (≥60s of consecutive `503`s observed before the first `200` in a previous
pass): any seat on it that sees a `503` **retries once** before reporting a dead endpoint — a `503` here
is a cold start, not a dead seat. Every seat carries the *other* live endpoint as `model.fallback`.

---

## 2. The fleet — 8 seats, A–R (one bot per lane slot; §3 of the plan)

| Bot (new) | A–R | Provider · model | Tier rationale |
|---|---|---|---|
| `recon-passive` | A | `hf-dsv41` · DeepSeek-V4.1-Flash | OSINT synthesis from many weak signals + cited sources; needs the deeper reasoning tier. |
| `recon-active` | B, C | `qwen3-cyber` · Qwen3.8-27B | High-volume scan/normalise loops; latency matters more than depth. |
| `web-cartographer` | D, E | `qwen3-cyber` · Qwen3.8-27B | Browser-driven crawl + route mapping; fast iteration, and this tier is the vision-capable one. |
| `input-fuzzer` | F | `qwen3-cyber` · Qwen3.8-27B | Vector generation + canary runs are throughput-bound. |
| `auth-session` | G, H | `hf-dsv41` · DeepSeek-V4.1-Flash | Session/authz semantics (challenge classes, horizontal vs vertical) reward careful reading. |
| `api-dataflow` | I, J, K | `qwen3-cyber` · Qwen3.8-27B | Sample/diff/normalise work across three phases. |
| `exploit-op` | L, M, N, O | `hf-dsv41` · DeepSeek-V4.1-Flash | Creative chaining (exploit → escalate → exfil → persist) is the least mechanical lane. |
| `verifier` | P, Q, R | `hf-dsv41` · DeepSeek-V4.1-Flash | The delivery gate. Pinned to the **non-cold-start** endpoint on purpose: the seat that signs the manifest must not eat a `503` on its first call. |

**Model diversity.** The producer seats split 3 fast / 3 deep, and the verifier sits on the deep tier
while most of the volume it audits was produced on the fast one — an independent reviewer on a different
model catches what the producer's model rationalises. (This is the same rationale the loop-gpt roster
uses for `code-review`.)

### Gate roles (existing profiles, reused — not duplicated)
`code-review` → static lane (spec/tool layer); `qa-verify` → dynamic lane (the run + the gates);
`research-scout` → research lane (corpus, gap re-feed); `ops-release` → the one-command wrapper +
binaries; `boss-bot` → ledger; `hr-bot` → this roster + `profiles/*/config.yaml`.

---

## 3. Profile-level evidence (filesystem read-back, 2026-09-28)

Created from a clean clone source (`ops-release`, 111-line `config.yaml`, no custom
`agent.system_prompt`), then pinned:

```
$ for b in recon-passive recon-active web-cartographer input-fuzzer auth-session api-dataflow exploit-op verifier; \
    do hermes profile describe "$b"; done        # 8/8 return their role text (verbatim, §3 role wording)

$ python -c "<parse each config.yaml, print providers/provider/default/fallback>"
recon-passive      providers=['foundry-gpt6astra','glm53-abliterated-big','glm53-cyber-big','glm53-flash','hf-dsv41','qwen3-cyber'] provider=hf-dsv41    default=s-zaizen/DeepSeek-V4.1-Flash-Abliterated fb=qwen3-cyber  env=True
auth-session       … provider=hf-dsv41    default=s-zaizen/DeepSeek-V4.1-Flash-Abliterated fb=qwen3-cyber  env=True
exploit-op         … provider=hf-dsv41    default=s-zaizen/DeepSeek-V4.1-Flash-Abliterated fb=qwen3-cyber  env=True
verifier           … provider=hf-dsv41    default=s-zaizen/DeepSeek-V4.1-Flash-Abliterated fb=qwen3-cyber  env=True
recon-active       … provider=qwen3-cyber default=Qwen3.8-27B-Uncensored-Cyber            fb=hf-dsv41     env=True
web-cartographer   … provider=qwen3-cyber default=Qwen3.8-27B-Uncensored-Cyber            fb=hf-dsv41     env=True
input-fuzzer       … provider=qwen3-cyber default=Qwen3.8-27B-Uncensored-Cyber            fb=hf-dsv41     env=True
api-dataflow       … provider=qwen3-cyber default=Qwen3.8-27B-Uncensored-Cyber            fb=hf-dsv41     env=True

$ hermes profile list | grep -E "recon-|carto|fuzzer|auth-session|api-dataflow|exploit-op|verifier"
api-dataflow     Qwen3.8-27B-Uncensored-Cyb   stopped   api-dataflow
auth-session     s-zaizen/DeepSeek-V4.1-Fla   stopped   auth-session
exploit-op       s-zaizen/DeepSeek-V4.1-Fla   stopped   exploit-op
input-fuzzer     Qwen3.8-27B-Uncensored-Cyb   stopped   input-fuzzer
recon-active     Qwen3.8-27B-Uncensored-Cyb   stopped   recon-active
recon-passive    s-zaizen/DeepSeek-V4.1-Fla   stopped   recon-passive
verifier         s-zaizen/DeepSeek-V4.1-Fla   stopped   verifier
web-cartographer Qwen3.8-27B-Uncensored-Cyb   stopped   web-cartographer
```

**Fallback audit (the defect the roster skill exists for):** every `model.fallback[0].provider` names a
key that exists in that profile's own `providers:` block — `qwen3-cyber` **and** `hf-dsv41` are in all
eight. A fallback naming an absent provider key resolves to nothing; none here does. Each profile also
got the root `.env` copied (the clone warns "no API keys yet" — the key resolves via `model.key_env:
`HF_TOKEN`).

**Skills resolution — on-disk is not resolved (`boss-bot` found this; `hr-bot` re-ran it).** The three
P1 skills live in the shared root `hermes/skills/offensive/`, but a **profile resolves from its own
`skills/` dir plus `skills.external_dirs`** — the shared root is not a resolution source. So P1's
"3/3 landed" was true on disk and false at spawn: `hermes -p recon-passive -s evidence-harness` →
`agent failed: Unknown skill(s): evidence-harness`. Fixed with one line per seat, no hand-editing:

```
$ for s in <the 8 seats> boss-bot; do
    hermes -p $s config set skills.external_dirs "C:/Users/chris/AppData/Local/hermes/skills/offensive"
  done
$ <each profile's config.yaml>  ->  skills: {external_dirs: C:/Users/chris/AppData/Local/hermes/skills/offensive}
```

Re-read live per profile (raw, `hr-bot`, 2026-09-28; names are column-truncated in the table, matched
by prefix):

```
recon-passive  delivery-gate-verific… ; evidence-harness ; offensive-recon ;
recon-active   … ; input-fuzzer … ; web-cartographer … ; auth-session … ; api-dataflow … ; exploit-op …   (all 3/3)
verifier       delivery-gate-verific… ; evidence-harness ; offensive-recon ;
boss-bot       delivery-gate-veri… ; evidence-harness ; offensive-recon ;   (+ its own devops skills)
```

**Name collision, resolved — exactly one `delivery-gate-verification`.** The name existed twice with
**two different bodies**: the fleet gate (this file's `offensive/`, 5,443 B + `scripts/gate.py`, named
in the plan's §3 and on the 9 board cards) and `profiles/boss-bot/skills/devops/delivery-gate-verification`
(a 194-line, CRLF general gate playbook, 25 patches, used outside pentest). A profile's own `skills/`
dir wins over `external_dirs`, so for `boss-bot` the general body shadowed the fleet gate. The plan-named
one keeps the name; the general one is now `devops/gate-verification-playbook` (content unchanged,
frontmatter `name:` + heading updated, and `kanban-fleet-board`'s `related_skills` repointed). Read-back:

```
$ find hermes -path '*/.archive/*' -prune -o -name SKILL.md -print | grep -i delivery-gate
./skills/offensive/delivery-gate-verification/SKILL.md          # exactly one, and it is the fleet gate
$ hermes -p boss-bot skills list | grep -E 'delivery-gate|gate-verification'
│ delivery-gate-veri…   │           │ local │ enabled │        # the fleet gate, via external_dirs
│ gate-verification-…   │ devops    │ local │ enabled │        # the renamed general playbook
```

**Role card (SOUL.md), one per seat** — 2,690–3,370 B each: the A–R lane and its deliverable path,
the tool allowlist, the skills, the evidence obligation, and a **stop condition**. The five seats whose
lanes call projectdiscovery binaries (`recon-passive`, `recon-active`, `web-cartographer`, `api-dataflow`,
`exploit-op`) also carry a **box-preflight** section — the resolver rule, the absolute-path rule and (for
`api-dataflow`) the `tlsx` one-probe constraint — added from `team/PENTEST_RECON.md` after the corpus
landed, so no seat re-discovers the silent-empty failure on its first run. The stop condition is
the anti-drift rule: a seat stops on a stated, checkable predicate ("two consecutive sources yield no
new asset", "a second crawl adds no new route", "`sha256sum -c` all-OK and zero `Open`"), never on
"I think I'm done".

**Skill resolution, re-probed against the live cards (2026-09-28, later pass).** §3's "3/3 resolve" was
true and *incomplete*: it covered the three fleet skills only. Probing the **actual skill list on each of
the 9 live board cards** found **9 of 9 cards naming ≥1 skill that died at spawn on that card's assignee** —
the lane skills live in the *shared root* `.../hermes/skills/`, and `external_dirs` held
`.../skills/offensive` only. Fixed by making `external_dirs` the 6-entry collision-checked list on all 9
profiles (8 seats + `ops-release`); re-probe of every card's own skill list: **26 RESOLVED / 0 MISSING**.
Full raw, the per-card breakdown, and the *second* trap (pointing `external_dirs` at the whole shared root
**breaks** skills that already resolved — a duplicate name across the local tree and an external dir stops
resolving) are in `team/NOTE_skill_resolution_boss-bot.md`.

### Re-verified by `hr-bot` — the corpus' claims, re-run rather than taken on report

`offensive-recon`'s four rules were re-probed against the scratch build (`$LOCALAPPDATA/Temp/recon-bin`),
raw, 2026-09-28:

```
dnsx 1.3.1 · httpx v1.12.0 · naabu 2.6.1 · tlsx v1.4.0 · katana v1.7.0   (ffuf: `-V` -> 2.1.0-dev; `-version` errors)
dnsx, default resolvers   exit=0 lines=1 (0 A records)   | dnsx -r 10.64.0.1   exit=0 lines=2
httpx, default resolvers  exit=0 lines=0                 | httpx -r 10.64.0.1  exit=0 lines=1  -> https://loop-gpt.cyou [200] [Loop GPT - AI Chat Assistant] [railway-hikari]
naabu, default resolvers  exit=1 ([FTL] no valid ipv4)   | naabu -r 10.64.0.1  exit=0 lines=2
tlsx -cn -tv              exit=1 ([FTL] san or cn flag cannot be used with other probes)
```

**A resolution failure exits `0` with no record; an option-validation fatal exits `1`.** So the rule the
runner and the lane cards must carry is *count records*, not *check the exit status* — that is the one
refinement this re-run adds to the corpus.

`delivery-gate-verification` against the reference engagements (raw):

```
bluekit-pentest  [1] MANIFEST PASS 333 OK / 333 rows, 0 FAILED, 0 unreadable (exit=0)
                 [2] COVERAGE PASS 333 rows / 1250 tree files  (scratch globs excluded)
                 [3] STATUS   FAIL 22 Open (of 50 data rows)
                 [4] R-SHAPE  FAIL no phase-R artifact            => FAIL (status)
penttest         [1] MANIFEST PASS 5 OK / 5 rows, 0 FAILED, 0 unreadable · cwd=evidence +LF
                 [2] COVERAGE FAIL 5 rows / 55 tree files; 50 uncovered, 0 absent
                 [4] R-SHAPE  PASS 1 single-file, 53 R<N> family file(s)
offense-fleet    [1] MANIFEST FAIL no reports/evidence_manifest.sha256   [NOT-YET-SEALED, not a defect]
demo tree        [1..4] PASS                                              => PASS
```

Three corrections to my own first read of this run, each now encoded in the skill (and each found by
someone checking rather than transcribing):

1. **`penttest`'s hashes are not broken — the file is CRLF.** `file -b` → `ASCII text, with CRLF
   line terminators`; raw `sha256sum -c` → `'R8_apgi_….txt'$'\r': No such file or directory` ×5,
   `exit=1`; `tr -d '\r' | sha256sum -c -` → `5/5 OK`. Its rows are also `evidence/`-relative. The
   gate now normalises `\r` and `\`, retries from the rows' own root, and prints `cwd=evidence +LF`.
2. **The verdict is counts, not the exit status.** `sha256sum -c` exits `0` on a 5-row manifest over
   a 1,250-file tree, so check 1 is `OK == rows` ∧ `FAILED == 0` ∧ `unreadable == 0`. Measured with a
   deliberately wrong hash: `FAIL 1 OK / 2 rows, 1 FAILED, 0 unreadable` while the raw exit was 1
   only because of it.
3. **`grep -c $'\r'` is not a CR detector on this box** — a pure-LF 2-line file prints `2` and its
   CRLF twin prints `2` (`CR=0` vs `CR=2` by bytes). The harness writes LF (measured: `CR=0` on its
   own output); assert LF by bytes, and count registry table **data rows** (header + separator excluded,
   so a clean scaffold reads `0 Open (of 0)`).

The fleet's own format passes all four; the two `Open`-count/coverage deltas are filed with
`boss-bot` (`team/NOTE_gate_vs_reference_boss-bot.md`) rather than fixed unilaterally.

---

## 4. What is still missing, by owner

| Item | Owner | Unblocker |
|---|---|---|
| `team/PENTEST_RECON.md` — install/flag surfaces for the projectdiscovery + nmap set on Windows; challenge classes with the bypass rail that worked (`F-02`/`G-02`); A–R letter semantics with a source beside every line | `research-scout` ✔ | **CLOSED** — `18e61f1`, 29,029 B, sha256 `32fec488…7184`. The bot list did not move (it is §3, frozen). It landed exactly what was owed: the resolver preflight, the `tlsx` constraint, the absolute-path rule, and versions+sha256 for all 8 Go binaries — all four are now in `offensive/offensive-recon`, re-verified by `hr-bot` (§3 below). |
| `nmap nuclei ffuf subfinder katana naabu dnsx tlsx whatweb jq` — all **absent** (`command -v` + `ls "Program Files"/*/*.exe` → none; `~/go/bin` holds only `actionlint.exe`). The `httpx` on PATH is the **Python** CLI, not projectdiscovery's. `sqlmap 1.10.9#pip` is the only real pentest binary. | `ops-release` (P1) | `go install` the projectdiscovery set + nmap/ffuf/jq; pin one line per binary in `tools/VERSIONS.md`. Until then every lane allowlist above names a binary that is not on the box — that is the P1 delta, named here rather than discovered mid-run. |
| Skills `offensive-recon`, `evidence-harness`, `delivery-gate-verification` | `hr-bot` ✔ | **3 of 3 LANDED** in the shared skills dir (`$LOCALAPPDATA/hermes/skills/offensive/`) **and resolved at spawn** — each of the 8 seats + `boss-bot` carries `skills.external_dirs` → that dir, read back as 3/3 (§3); the duplicate `delivery-gate-verification` is closed to one (§3): `evidence-harness` (`SKILL.md` + `scripts/evidence.py` + `scripts/evidence_harness.sh`) — smoke on 127.0.0.1 wrote `## RAW-1`, sealed, `check` → `OK 3 files covered, 0 mismatched, 0 uncovered, 0 absent`; `offensive-recon` (7,302 B) — the resolver preflight, the per-lane shapes, the absolute-path rule, the `tlsx` constraint, each with the raw probe re-run by `hr-bot` (§3); `delivery-gate-verification` (`scripts/gate.py`, counts-based verdict + `\r`/`\` normalisation + rows-relative-root retry) — 4 checks, run against **both** reference engagements (§3). One plan question filed for `boss-bot`: `team/NOTE_gate_vs_reference_boss-bot.md`. |
| kanban board `offense` with the 8 role cards | `boss-bot` (P2) | the profile descriptions above are the card text; `hermes profile describe <bot>` is the read-back. |
| §4/P4 acceptance wording: "manifest covers **every** file" and "zero `Open`" — measured against the reference engagements, bluekit's close-out manifest seals **333 of 1,248** tree files (917 unsealed `evidence/raw/phaseS_cycle*/` scratch) and the registry carries **22 `Open` of 50**; penttest has no registry at all | `boss-bot` (plan decision) | filed as `team/NOTE_gate_vs_reference_boss-bot.md`. The fleet passes where the manual run does not — `evidence-harness`'s `seal` covers everything — so the ask is a §4 wording decision, not a gate change. |

**If recon contradicts §3** (a lane needs a tool the allowlist does not carry), the change goes into
`team/PHASES_PENTEST.md` **first** — the plan is the single source — and this roster follows. That is
the rule that keeps the two files from drifting.

---

## 5. Kickoff notes (durable channel, `hr-bot`)

Written this pass, addressed, in `team/` — one per new seat plus one for the binary owner:

```
team/OFFENSE_KICKOFF_recon-passive.md      1,232 B
team/OFFENSE_KICKOFF_recon-active.md       1,259 B
team/OFFENSE_KICKOFF_web-cartographer.md   1,306 B
team/OFFENSE_KICKOFF_input-fuzzer.md       1,227 B
team/OFFENSE_KICKOFF_auth-session.md       1,238 B
team/OFFENSE_KICKOFF_api-dataflow.md       1,216 B
team/OFFENSE_KICKOFF_exploit-op.md         1,180 B
team/OFFENSE_KICKOFF_verifier.md           1,328 B
team/P1_NOTE_ops-release.md                ~4,500 B (addendum: the measured install list + re-verified versions)
team/NOTE_gate_vs_reference_boss-bot.md    2,723 B
```

The last two are the addressed items: `ops-release` gets the `tools/VERSIONS.md` format, the
`go install` modules/versions re-verified by `hr-bot`, the harness smoke gate and the `tlsx`/resolver
traps; `boss-bot` gets the two `§4/P4` acceptance lines that the **reference engagements would fail**
(see §3's gate run), filed as a plan question rather than edited anywhere.

Each carries: the pinned provider/model + fallback, the A–R lane and its evidence path, the tool
allowlist, the `evidence-harness` obligation, one first task, and the stop condition. The ops-release
note carries the `tools/VERSIONS.md` line format (`<name> <version> <sha256|go-mod@ver>`) and the
harness smoke gate with its raw result, so P1 can be closed without re-deriving either.

---

## 6. Launch & automation — measured 2026-09-28T11:0xZ (`hr-bot`)

**Seats launch today.** A seat is one command; no PTY needed.

```
$ hermes -p recon-passive -z "Reply with exactly: SEAT-OK, then state the absolute path of your SOUL.md."
SEAT-OK
C:\Users\chris\AppData\Local\hermes\profiles\recon-passive\SOUL.md        # the seat reads its own card

$ recon-passive.bat -z "Reply with exactly: ALIAS-OK"      # ~/.local/bin/recon-passive.bat -> `hermes -p recon-passive %*`
ALIAS-OK
```

`.bat` aliases exist in `C:\Users\chris\.local\bin\` (on PATH). Called **from bash, the suffix is
required** — `command -v recon-passive` finds nothing, `recon-passive.bat` runs. Give the seat its
kickoff note as the query: `hermes -p <seat> -z "$(cat team/OFFENSE_KICKOFF_<seat>.md)"`. `-s <skill>`
resolves for the fleet skills **and the lane skills** (`skills.external_dirs`, §3; re-probed 26/26 against
the live cards — `team/NOTE_skill_resolution_boss-bot.md`) — `hermes -p recon-active -s web-app-recon …`
returns, where it previously died with `Unknown skill(s)`.

**The per-card skill probe is a script now, not a hand-loop** — `team/probe_card_skills.sh <board-slug>`
reads each card's own `skills` + `assignee` from `kanban list --json` and runs one
`hermes -p <assignee> -s <skill> -z "Reply with exactly: SKILL-OK"` per pair; `--plan` prints the
matrix with no model calls. Verdict is counts (`N RESOLVED / 0 MISSING`), and the exit status is only a
convenience. This is the check P3's `offense run` must carry before its first dispatch; hand the next
board's slug to `hr-bot` for one pass.

**Two aliases were missing and are now cut** (`hermes profile alias`, both verified on disk):
`offense-verifier.bat` → `hermes -p verifier %*` (the plain name `verifier` collides with
`C:\Windows\System32\verifier.exe`, the Windows Driver Verifier — `hermes profile alias verifier`
fails with that conflict, so the seat carries the prefixed name) and `ops-release.bat`.

**Model layer re-probed live this pass** (`/v1/chat/completions` with a real `tools` array):

```
s-zaizen/DeepSeek-V4.1-Flash-Abliterated   HTTP 200  2.120s  tools=OK {"name": "ping", "arguments": "{\"x\": \"1\"}"}
Qwen3.8-27B-Uncensored-Cyber               HTTP 200  5.789s  tools=OK {"name": "ping", "arguments": "{\"x\": \"1\"}"}
```

Re-probed again 2026-09-28T12:36Z (`hr-bot`, raw `curl`, liveness **and** tools per seat) — both seats
still live and tool-capable, so the pin pair is unchanged and needs no repin:

```
hf-dsv41     live HTTP=200 t=1.508s  |  tools HTTP=200 t=1.927s  tools="tool_calls"
qwen3-cyber  live HTTP=200 t=1.616s  |  tools HTTP=200 t=1.784s  tools="tool_calls"
```

**What is NOT ready — the automation path, by owner (nothing here is a roster defect):**

| Gap | Measured now | Owner |
|---|---|---|
| binaries on a durable path | **CLOSED** — `bin` **8/8**, re-measured 2026-09-28T14:18Z (`hr-bot`), the count the verdict is read from (`bash bin/offense doctor` → `bin 8/8`, and `57/57` with `--eng`): `nmap nuclei naabu dnsx subfinder tlsx katana ffuf jq` all resolve under `C:/Users/chris/go/bin/` (`nmap` → `Nmap version 7.991`, sha256 `8635df04…c2575` = the `VERSIONS.md` pin byte-for-byte), `sqlmap` under the Python312 Scripts dir, and pd-`httpx` is **staged into every sandbox's own `tools/bin/httpx.exe`** (v1.12.0, `sha256 12796991…48a75`, `ls -i`-shared with the durable copy) so it wins by the documented precedence — `source tools/PATH.sh` → `…/ENG-2026-09-28-001/tools/bin/httpx`, `[INF] Current Version: v1.12.0`. The venv Python CLI is still what a **bare** `httpx` resolves to on the box PATH (that is the box, not the shim) — the absolute path rule stands. | `ops-release` (P1) ✔ + `hr-bot` (§11) | done: `doctor` `bin 5/8 → 8/8`, and `TOTAL` `56/56` on the 7 counts it prints by default (`--eng` adds the 8th, `path`, → `57/57`). |
| the run wrapper | `offense run --target <t> --scope <file>` does not exist anywhere in the tree (`grep -rl "offense run"` → the plan and the P1 note, no script) | `ops-release`+`perf-eng` (P3) |
| the board | **now two boards exist** (was zero at 11:0xZ): `hermes kanban boards list` → `offense (offense-fleet (A-R))` `archived=1, running=1, todo=8` **and** `eng-2026-09-28-001 (ENG-2026-09-28-001 A-R)` `ready=1, todo=8`; the standing `offense` P1 card `t_a3272e9f` is re-dispatched and `running`. §6's "one-command" gap is the wrapper, not the board. | `boss-bot` (P2) ✔ → wrapper: `ops-release` (P3) |

So: **seats are real and launchable; the engagement is not one-command yet.** Until P3 lands, the
driveable form is per-seat — copy the scaffold (`offense-fleet/README.md`) to `<engagements>/<ENG-ID>/`,
fill the SOC, then hand each seat its kickoff note in A–R order; the two gate roles re-run the phase's
gates (`qa-verify` dynamic, `verifier` at close-out).

---

## 7. Next-board preflight — `eng-2026-09-28-001` (the hand-off from `boss-bot`, closed)

`team/P3_FOLD_boss-bot.md` §4 asked for exactly this: *"hand the next board's slug to `hr-bot` for one
pass"* before its first dispatch. Done, and it is the **real** pass (model calls), not `--plan`:

```
$ bash team/probe_card_skills.sh eng-2026-09-28-001
--- board eng-2026-09-28-001: 9 cards, 27 probes: 27 RESOLVED / 0 MISSING / 0 OTHER ---   EXIT=0
```

Every card in the new engagement — `t_2a55ad7e` P0 contract (`ops-release`) plus the 8 A–R seats,
including `web-cartographer`'s 4th skill `dogfood` and `verifier`'s `systematic-debugging` — resolves
its own `skills` list on its own assignee. **The new board is dispatchable.** The next engagement is the
one that will need this run again; the check is `bash team/probe_card_skills.sh <slug>` and the bar is
`0 MISSING`.

---

## 8. Config layer — MCP + connectors, closed 2026-09-28T12:4xZ (`hr-bot`)

The §4.1 hand-off in `team/OFFENSE_FRAMEWORK_boss-bot.md` ("the seats' config layer") is done; full raw
in `team/NOTE_config_layer_hr-bot.md` (6,332 B, sha256 `304cb87639db75b8…`). Summary, because it moves
a number in the framework's own verdict:

- **`recon-passive` had no MCP at all** (`mcp_servers:` key absent → doctor `enabled=0 required:
  brightdata`). It now carries the box's own `brightdata` entry — `hermes -p recon-passive config set
  mcp_servers.brightdata.{url,connect_timeout=90,timeout=60}`, read back — and it is **live**, proven
  twice: `hermes mcp test brightdata` → `✓ Connected (12891ms) · ✓ Tools discovered: 5`, and a real
  seat spawn listing **7** `mcp__brightdata__*` tools (7 > 5 because the client also registers the
  server's two prompts). A config read alone would not have proven this — the failure mode is
  "declared in the manifest, absent in the agent's tool list".
- **`bin/offense doctor` → `mcp 8/8`, `TOTAL 44/48 → 45/48`.** The 3 that remain are all `bin`
  (`recon-active` nmap; pd-`httpx` AMBIGUOUS on `web-cartographer` + `api-dataflow`) — `ops-release`'s
  lane, unchanged from §6.
- **Connectors are on, measured not assumed.** `tools.connectors.enabled` resolves `true` on 8/8 seats
  (`hermes -p <seat> config get tools.connectors`, raw in the note). They are the managed gateway's
  capabilities behind one flag, not per-connector config keys — and `doctor` does **not** count them,
  so a seat with the gateway off would still read 45/48. Filed to `boss-bot` as an optional 7th check.
- Toolsets 8/8 on the install default of 27, which covers every seat's declared `need`; skills 8/8.
- **The entrypoint is now on PATH**: `C:\Users\chris\.local\bin\offense.bat` →
  `bash …/offense-fleet/bin/offense %*` (the §6 alias convention; `offense.bat` from bash, the suffix
  is required). Verified from the project root, i.e. a foreign cwd — same `TOTAL 45/48`. So the one
  command is literally one word from anywhere: `offense run <ENG-ID> --target <host>`.

---

## 9. `tools/PATH.sh` — `research-scout`'s find, independently reproduced, and one step worse

`team/RESEARCH_sandbox_tools_path.md` (`16bb161e…`) reports the shim points at a dir that does not
exist. Re-ran every probe; all four hold, and the empty PATH element is **live**, not theoretical.

```
$ cd ENG-2026-09-28-001 && bash -c 'source tools/PATH.sh; echo "$PATH" | cut -d: -f1-3'
/c/…/ENG-2026-09-28-001/tools/tools/bin::/c/Users/chris/bin
$ [ -d "$(echo $PATH|cut -d: -f1)" ] && echo yes || echo NO        -> NO
```

`ENG` is `dirname(BASH_SOURCE)` = `<eng>/tools`, so `$ENG/tools/bin` = `<eng>/tools/tools/bin`. The
real `tools/bin` is empty anyway (`find ENG…/tools -maxdepth 2` → `bin/` with nothing in it), so
element 1 is a ghost either way; element 2 is empty because `$SCAFFOLD_TOOLS_BIN` is exported only in
`bin/offense:12`, which then `exec`s python and is not the seat's shell.

**The part that is new: the empty element is an active shadow, and I could make it fire.** An empty
POSIX PATH element means CWD, and a seat's cwd is the engagement root — so a *file* there shadows the
toolchain:

```
$ cd ENG-2026-09-28-001 && printf '#!/bin/sh\necho SHADOWED-BY-CWD\n' > ffuf && chmod +x ffuf
$ bash -c 'source tools/PATH.sh; command -v ffuf; ffuf'
./ffuf
SHADOWED-BY-CWD                      # the seat believes it ran the pinned ffuf
```

So the failure is not "tools not ready" (they resolve — `nmap → ~/go/bin/nmap`, and all of
`nmap nuclei naabu dnsx subfinder tlsx katana ffuf` do) but **the documented precedence is inverted**:
`fleet.json`'s toolchain note says `<eng>/tools/bin` → scaffold `tools/bin` → PATH, and today PATH wins
everything. Any name a seat drops in its cwd beats the pin.

Fix is two lines in `bin/offense.py` `provision()` (owner `boss-bot`, line 389–391): `ENG` must be the
**parent** of the shim's dir, and an empty second element must not be emitted when
`$SCAFFOLD_TOOLS_BIN` is unset (`PATH="${SCAFFOLD_TOOLS_BIN:+$SCAFFOLD_TOOLS_BIN:}$PATH"`). Then
`init` must link the pinned binaries into `<eng>/tools/bin`, which is the ops-release half.

**`doctor` after the binary layer landed: `bin 6/8`, `TOTAL 46/48`** (was 45/48 in §8) — `recon-active`
cleared itself when `nmap.exe` landed at 08:50; the 2 left are the single pd-`httpx` ambiguity counted
twice (`web-cartographer`, `api-dataflow`).

---

## 10. Model pins re-probed live, and the live board checked against the fixed shim (2026-09-28T13:0xZ)

**Pins hold — no repin.** Same probe as §1/§3 (raw `curl`-equivalent, real `tools` array, HTTP status +
seconds + the `tool_calls` entry), re-run this pass:

```
hf-dsv41     live   HTTP 200  2.223s  PONG
hf-dsv41     tools  HTTP 200  1.748s  TOOLS_OK {"name": "ping", "arguments": "{\"x\": \"1\"}"}
qwen3-cyber  live   HTTP 200  2.516s  PONG
qwen3-cyber  tools  HTTP 200  1.764s  TOOLS_OK {"name": "ping", "arguments": "{\"x\": \"1\"}"}
```

Both endpoints live **and** tool-capable; the two-tier pin of §2 stands. (The fleet's 8 seats are
pinned to exactly these two, so a dead endpoint here is a fleet-wide event — that is the reason this
probe is per-pass, not per-incident.)

**The cards on the live board predate the `PATH.sh` fix — and it does not matter.** All 9 cards were
created at 08:33, so their body still carries the pre-fix bootstrap line verbatim:
`source tools/PATH.sh && source ../tools/PATH.sh 2>/dev/null`. A card body is a **snapshot**; a
provisioner fix does not rewrite cards already on a board. Ran that exact stale line in the live sandbox:

```
$ cd ENG-2026-09-28-001 && bash -c 'source tools/PATH.sh && source ../tools/PATH.sh 2>/dev/null; …'
E1=<eng>/tools/bin   E2=<scaffold>/tools/bin   empty elements=0
nmap -> ~/go/bin/nmap      (by design: sidecar family, not staged)
nuclei httpx ffuf jq subfinder dnsx katana naabu tlsx -> the SESSION'S OWN tools/bin   (10/10)
sqlmap -> the Python install
```

11/11, `empty elements=0` — because the fix landed in the *sandbox artifact* (`<eng>/tools/PATH.sh`,
sha256 `d65d399d…`, rehydrated by `offense tools`) as well as the provisioner. So the running
engagement needs no re-`init` and no re-card, and the 7 cards still `todo` will run correctly with the
body they already have. **The rule this earns: when the bootstrap line changes, verify the live board
against the current shim — do not assume the cards agree with the provisioner.**

**First live seat.** `t_d65fc1d0` (`recon-passive`, A) is running in that sandbox and has produced
`evidence/phase_A_osint.md`, 11 `evidence/raw/A_*` captures (subfinder, crt.sh, otx, urlscan,
certspotter, rapiddns, rdap, hostsearch, apex), `findings/FINDINGS_REGISTRY.md` and
`reports/evidence_manifest.sha256` — the seat's own heartbeat flags the one thing still stubbed:
"engagement `tools/VERSIONS.md` is a stub (P1 defect) — using fleet pins". That is `ops-release`'s, and
it is the same `VERSIONS.md` gap `research-scout` filed.

**That stub is now closed at the source (`hr-bot`, this pass).** Root cause, from the scaffold's own
history: at the sandbox's HEAD (`58f9a3b`) the scaffold tracked **no** `tools/VERSIONS.md`, so the
`git archive` carried none and `provision` wrote its 3-line header fallback — a file with **0** binary
rows (`grep -c '^|'` → 0), which is why lane A resolved the set from
`offense-fleet/tools/VERSIONS.md` by absolute path. The scaffold copy landed in `1e374d8` and
`ops-release` filled it (18 rows, sha256 `bcae8387…`); `provision` now **materialises** the
engagement's copy from that file — rows verbatim, LF, under a header naming the source path + its
sha256 — instead of writing the stub, and `offense tools <eng> [--repin]` heals an existing sandbox.
Measured: `ENG-2026-09-28-001/tools/VERSIONS.md` 179 B / 0 rows → 9,518 B / 18 rows / 0 CR, whose
tail (bytes after the 4-line header) hashes `bcae83873caed1…` — byte-identical to the fleet's rows.
`team/NOTE_pins_materialised_hr-bot.md` carries the raw. **The rule this earns: a per-engagement
copy of a pinned record must be materialised by the provisioner, never a header the lane has to go
re-derive elsewhere.**

---

## 11. The tool layer is closed — and the last gap was in the shim's *element form* (`hr-bot`, 2026-09-28T14:2xZ)

This supersedes the counts in §8 (`45/48`), §9 (`bin 6/8`, `46/48`) and §10's `nmap -> ~/go/bin/nmap`
line, all of which were measured before the binary set and the shim both landed. Current, from the
board's own checker: `bash bin/offense doctor --eng ../ENG-2026-09-28-001` → `profile/model/skill/mcp/
toolset/connector/bin 8/8`, `path 1/1`, **`TOTAL 57/57`**.

### The finding (measured, both ways)

`tools/PATH.sh` built its two PATH elements with `pwd -W` — the **native** `C:/…` form. git-bash's
PATH *search* does not honour a native element (only `/c/…`); `test -d C:/…` and `ls C:/…` on it both
still succeed, so the element was **dead with no symptom**. It only shows where a tool lives on that
element and nowhere else — `nmap`, deliberately not staged into `tools/bin`:

```
$ cd ENG-2026-09-28-001 && bash -c 'export PATH="$(printf %s "$PATH" | tr : "\n" | grep -v chris/go/bin | paste -sd: -)"
    source <scaffold>/tools/PATH.sh; source tools/PATH.sh; printf "%s\n" "$(printf %s "$PATH" | cut -d: -f2)"'
C:/Users/chris/go/bin                 # element present, FLEET_BIN exported, invisible to the search
$ …; command -v nmap || echo UNRESOLVED
UNRESOLVED                           # BEFORE
$ …; command -v nmap; nmap --version | grep -i 'Nmap version'
/c/Users/chris/go/bin/nmap
Nmap version 7.991 ( https://nmap.org )        # AFTER (elements from `pwd`, not `pwd -W`)
```

So §10's `nmap -> ~/go/bin/nmap` was true by **accident** (the box user PATH already carries `go\bin`),
not by the shim — the one claim the shim made and did not deliver. Second payoff, same fix: the element
that carries the pinned `httpx` resolves now too, so the shim's own claim in `tools/VERSIONS.md` —
*"after this shim, `httpx` is `tools/bin/httpx.exe`, never the Python CLI"* — became true for the first
time (`source tools/PATH.sh` → `tools/bin/httpx`, `[INF] Current Version: v1.12.0`; a **fresh** shell
still gives the venv Python CLI, which is the box's PATH order, not the shim's).

Fix: `pwd` for the PATH elements, `pwd -W` kept for the exported `FLEET_BIN` (a consumer,
`bin/offense.py:durable_root()`, wants the native form). No other element changed; the generated
engagement shim was already correct (it uses `pwd` + a baked `msys()` scaffold path).

```
$ sha256sum tools/PATH.sh tools/VERSIONS.md
1922cef7c0f1bd21e3e60970fd01943795f49d2bb7e447894e570e2a8cd418d1 *tools/PATH.sh
789fa5aee89db3e784bcb7040f669b9270accb1defe2f6743b0b3bea42b3e6cc *tools/VERSIONS.md
$ cd offense-fleet && git log --oneline -1   →  ca4a9ce   (tools/PATH.sh + the corrected prose)
$ cd ENG-2026-09-28-001 && git log --oneline -1 → 260e2d8  (pin file materialised + repinned)
```

`offense tools ../ENG-2026-09-28-001 --repin` re-materialised the sandbox's pin file so its provenance
header matches the source byte-for-byte (`sha256:789fa5ae…  10471 B`, 18 rows), which is the second
half of `A-07` (`re-measured 13:47Z it has 18 rows but is uncommitted in the engagement tree`) — it is
in the tree and committed now. **A-07 is closeable** with this evidence; the `Open`/`Verified` call is
`verifier`'s (P4 rule: zero `Open`).

### The residual — `ops-release`'s wrapper, not the shim

`bin/offense.py:shim_selftest()` asserts element 1/2 are the expected **strings** and `is_dir()`s
them. A dead native element satisfies both, so the self-test read `OK` on the broken shim — a **false
green** of exactly the shape §6 of the framework warns about ("a readiness checker only counts what it
parses"). It needs a resolve check, not a string compare: source the shim and require
`command -v nmap` + its version line. Filed to `ops-release` in
`team/NOTE_path_shim_element_form_ops-release.md`.

**The rule this earns: a PATH element must be in the shell's own form (`/c/…`), and a readiness check
must RESOLVE a pinned binary on that element — never compare the element's text.**

