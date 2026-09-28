# NOTE — A-04/A-07 rows republished to the measured numbers; the A-row arithmetic is closed

to: room (`@hr-bot`, `@research-scout`, `@user`)   cc: `verifier`, `recon-passive`
from: `boss-bot` (owns the ledger)  2026-09-28T14:5xZ
Lane: static review (the finding ledger) → dynamic test. Evidence: raw commands below, this pass.

---

## 1. What changed (paths + bytes, measured here)

| path | before | after | commit |
|---|---|---|---|
| `projects/development/ENG-2026-09-28-001/findings/FINDINGS_REGISTRY.md` | A-04 "3 distinct CAs … inside a 90-day window" (`sha256 6cfb4b25…`); A-07 "0 binary rows; PATH.sh uncommitted-CRLF; httpx.exe untracked" | A-04 = the parsed numbers; A-07 = clauses 1–2 closed, clause 3 open (`sha256 6c0ba359…`) | `2ecadc1` |
| `…/ENG-2026-09-28-001/evidence/phase_A_osint.md` | same two rows (`sha256 03e36677…`) | same two rows + the A-04 FIND prose and an A-07 re-measure line (`sha256 72a1cbe4…`) | `2ecadc1` |
| `…/ENG-2026-09-28-001/reports/evidence_manifest.sha256` | 2 rows stale after the edit | 2 rows re-sealed; 1,990 B, `CR=0`, `sha256 479fabc4…` | `2ecadc1` |

## 2. A-04 — the numbers, from the raw JSON, not from prose

```
$ python -c "…"  over evidence/raw/A_crtsh.json
ct records: 9
distinct leaf serials: 5          # the 9 rows are per-log duplicates of 5 certs:
                                  # YR2 05a2bf30 ×2, YR2 067bf15d ×2, YE2 ×2, WE1 ×2, Cloudflare ×1
  2026-08-02T11:15:43  WE1      00d2cfad
  2026-08-02T11:59:55  YE2      05f60336
  2026-08-02T12:06:41  Cloudflare TLS Issuing ECC CA 4  33173084
  2026-08-18T19:45:04  YR2      067bf15d
  2026-08-19T01:58:59  YR2      05a2bf30
orgs: ['Google Trust Services', "Let's Encrypt", 'SSL Corporation']        # 3
issuing CA names: ['Cloudflare TLS Issuing ECC CA 4','WE1','YE2','YR2']   # 4
first->last elapsed: 16 days, 14:43:16
calendar-date span: 17 days
```

`research-scout`'s correction was right in direction and short by one count: it is **5 distinct leaf
certs**, not 4 — 4 is the **intermediate CA** count (YR2, YE2, WE1, Cloudflare TLS Issuing ECC CA 4)
across 3 organizations. And the span reads 16 days truncated, 17 by calendar date; the row now
carries the two `not_before` timestamps verbatim, which no rounding can move. Severity stays `Low`
(control absence, not misissuance — RFC 8659 §3), pointers moved to `RAW-31, RAW-18, RAW-19` so the
CT half of the claim resolves to where the CT data actually is.

## 3. A-07 — `hr-bot`'s close verified, one clause measured still open

```
$ sha256sum offense-fleet/tools/VERSIONS.md
789fa5aee89db3e7…            # = the sha256 the tree's provenance header cites  ✓
$ diff offense-fleet/tools/VERSIONS.md ENG-…/tools/VERSIONS.md
0a1,4                        # the 4-line provenance header, and nothing else  ✓ byte-for-byte body
$ grep -c '^|' offense-fleet/tools/VERSIONS.md
18                           # = 16 binaries + the header row + the rule row (not 18 binaries)
$ git -C ENG-… ls-files tools/
tools/PATH.sh tools/README.md tools/VERSIONS.md tools/a_osint_extract.py tools/lf_normalize.py
$ git -C ENG-… status --porcelain | grep tools
?? tools/bin/                # 9 pinned .exe — clause 3 of the A-07 row, still true
```

So A-07 stays `Open` on clause 3 alone; clauses 1–2 close at `260e2d8`. The row now says exactly
that, so the P4 close-out is not re-measuring a sentence that stopped being true.

## 4. The gate after the edit (raw)

```
$ bash bin/offense gate ../ENG-2026-09-28-001
1) MANIFEST   rows=20  header=2  CRLF=False  malformed=0
              verdict: rows=20 OK=20 FAILED=0 unreadable=0 malformed=0  -> PASS
2) COVERAGE   tree(evidence|findings|reports|SOC)=20  counted=20  manifest rows=20  -> PASS
3) STATUS+R   registry rows=7  Open=2   R shape A none / shape B 0 files  -> FAIL
--- gate: MANIFEST=PASS COVERAGE=PASS STATUS+R=FAIL ---
```

`STATUS+R=FAIL` is the expected mid-run state, not a regression: `Open` clears at Q (re-probe) and R
arrives with the verifier. `2 Open` = A-04 (needs the Q re-probe of the CAA query) + A-07 (clause 3).

## 5. One thing the room should know: there are two shims, and one proof

The cold-init evidence covers the **fleet's** `tools/PATH.sh` (2,896 B, `FLEET_BIN_POSIX`). The shim
a seat actually sources is **generated** by `offense init` (`bin/offense.py:201`) — in this tree,
416 B, `tools/PATH.sh`, committed. The generated shim is already POSIX (`pwd`, `/c/…`), so it is not
broken the same way; but it carries **no durable-root element** (`nmap` rides the box `PATH`) and
element 2 is the **standing fleet repo's absolute path**, baked in at init. That is a coupling to the
scaffold's location, not to the archive. Worth one line in `ops-release`'s `shim_selftest` fix
(the filed one-assertion resolve diff stands, and it is code-confirmed: `bin/offense.py:226-229`
compares element strings + `is_dir()`, never `command -v`).

## 6. Next owner + exact artifact

- `verifier` (Q): re-probe A-04's CAA query and A-07's clause 3, paste both raw, move the two rows
  `Open → Verified`/`Informational`; R then emits the manifest and the killchain file.
- `ops-release`: the resolve assertion in `shim_selftest` — `team/NOTE_path_shim_element_form_ops-release.md`
  (4,688 B @ 10:29Z) carries the diff.
- `@user`: a fresh target is a **new ENG-ID with its own `SOC/02_Scope.md`**, not a second
  `--target` on this one (this tree's scope names `loop-gpt.cyou` as the target of record, and
  `run`/`init` take `--target` as required and fill the SOC placeholders from it).
