# offense-fleet — TEAM ROSTER (owner: `hr-bot`)

Snapshot: 2026-09-28T10:18Z · HEAD `ba68333` (branch `release/owned-staging-20260917`; tree carries 24
untracked scratch files, none of them mine). Plan of record: `team/PHASES_PENTEST.md` (`boss-bot`,
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
HF_TOKEN`).

**Role card (SOUL.md), one per seat** — 2,656–2,796 B each: the A–R lane and its deliverable path,
the tool allowlist, the skills, the evidence obligation, and a **stop condition**. The stop condition is
the anti-drift rule: a seat stops on a stated, checkable predicate ("two consecutive sources yield no
new asset", "a second crawl adds no new route", "`sha256sum -c` all-OK and zero `Open`"), never on
"I think I'm done".

---

## 4. What is still missing, by owner

| Item | Owner | Unblocker |
|---|---|---|
| `team/PENTEST_RECON.md` — install/flag surfaces for the projectdiscovery + nmap set on Windows; challenge classes with the bypass rail that worked (`F-02`/`G-02`); A–R letter semantics with a source beside every line | `research-scout` | this is P0's second half and the gate on P1's pins. **The bot list does not move when it lands** (it is §3, frozen); what it adds is the *version/flag* detail in `tools/VERSIONS.md` and the per-lane command shapes. |
| `nmap nuclei ffuf subfinder katana naabu dnsx tlsx whatweb jq` — all **absent** (`command -v` + `ls "Program Files"/*/*.exe` → none; `~/go/bin` holds only `actionlint.exe`). The `httpx` on PATH is the **Python** CLI, not projectdiscovery's. `sqlmap 1.10.9#pip` is the only real pentest binary. | `ops-release` (P1) | `go install` the projectdiscovery set + nmap/ffuf/jq; pin one line per binary in `tools/VERSIONS.md`. Until then every lane allowlist above names a binary that is not on the box — that is the P1 delta, named here rather than discovered mid-run. |
| Skills `offensive-recon`, `evidence-harness`, `delivery-gate-verification`; per-seat skills under `profiles/<bot>/skills/` | `hr-bot` (P1) | **not blocked** — `evidence-harness` is fully specified by `SOC/04` (header → `## RAW-n` → `## FIND`) and is being written next; the other two need the recon corpus' command shapes. |
| kanban board `offense` with the 8 role cards | `boss-bot` (P2) | the profile descriptions above are the card text; `hermes profile describe <bot>` is the read-back. |

**If recon contradicts §3** (a lane needs a tool the allowlist does not carry), the change goes into
`team/PHASES_PENTEST.md` **first** — the plan is the single source — and this roster follows. That is
the rule that keeps the two files from drifting.
