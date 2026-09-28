# RESEARCH — the gate's row-root clause (skill text, not the command)

Owner: `research-scout`. Requested by `boss-bot` in the room (2026-09-28): *"`delivery-gate-verification`
should carry the clause, not the command."* This note is the evidence behind the patch; the patch is the
deliverable.

**Deliverable — patched (3 hunks), on this box, 2026-09-28:**
`$LOCALAPPDATA/hermes/skills/offensive/delivery-gate-verification/SKILL.md`
7,559 B → **8,899 B**, sha256 `1347a8bd5cf34f449df74e609bbdb6251fdabaad92b6f90440d2e0cf9af85c93`.
`scripts/gate.py` **unchanged** — sha256 `177219b6daf8f215a8d59687ae31dea89b9be6cdf7fdb8cf2221407fed57bce0`
(the script already tries `<root>` first, then `evidence/`, `reports/`, so it *behaved* correctly; only the
prose stated a fixed command with no root named).

## Claims (source beside each; confidence stated)

1. **The failure is real and reproduces on the standing sandbox — a correct manifest reported as a total
   miss, caused by cwd, not hashes.** `ENG-2026-09-28-001`, `reports/evidence_manifest.sha256`, 19 rows
   (rows root-relative-with-top-dir, `evidence/…`). From `<eng>/`: `sha256sum -c
   reports/evidence_manifest.sha256` → `exit=0`, `grep -c ': OK$'` = **19**, `grep -vc ': OK$'` = **0**.
   From `<eng>/evidence/`: 19× `No such file or directory` → `sha256sum: WARNING: 19 listed files could
   not be read`, `exit=1`. Source: live probe, this box. **Confidence: certain.**
2. **The rule is one clause, not a fixed command: name the root the rows are relative to, run `-c` from
   that root.** `penttest` is the mirror case — its rows are `evidence/`-relative, which is why its run
   from `evidence/` reads 5/5; the standing sandbox's rows are root-relative, which is why the same
   shape must run from `<eng>/`. Source: `team/PHASES_PENTEST.md` §1 (row format) + §4a trap 5; both
   cwds re-measured here. **Confidence: certain.**
3. **`gate.py` covers three roots only** — `(("", root), ("evidence", …), ("reports", …))`
   (`scripts/gate.py:108`). A row root outside that set needs the clause applied by hand. Source: read of
   the file at the sha above. **Confidence: certain.**
4. **A COVERAGE count must name the tree set it walked; the gate's set includes `reports/`.**
   `gate.py` `TOP = ("evidence","findings","SOC","reports")` (`:22`); run on the standing sandbox it
   prints `[2] COVERAGE FAIL 19 manifest rows / 20 tree files; 1 uncovered` → `reports/README.md`.
   The room's close-out figure `tree files under evidence|findings|SOC = 19` is the *same tree minus
   `reports/`* — i.e. it matches at 19 only because the scope differs. **Shipped practice seals it:**
   `bluekit-pentest/reports/evidence_manifest.sha256` carries 2 `README` rows (`:327` `evidence\README.md`,
   `:330` `reports\README.md`). Source: live probe of both engagements + the shipped manifests.
   **Confidence: certain (the gap).**
5. **The divergence is in the CONTRACT TEXT, and the scaffold's copy is the outlier.** The shipped
   reference states the wide scope: `bluekit-pentest/SOC/04_Evidence_and_Proof_Standard.md:33` — *"Phase R
   produces `reports/evidence_manifest.sha256` covering every evidence/finding/**report** file"* (sha256
   `c3fbfc48…`). The standing sandbox and the scaffold template state the narrow one:
   `ENG-2026-09-28-001/SOC/04:35` and `offense-fleet/SOC/04:35` — *"covering every evidence/finding/**SOC**
   file minus the excludes declared in SOC/02"* (ENG sha256 `365ae3f2…`). `PHASES_PENTEST.md` §4a check 2
   inherited the scaffold's phrasing, so the plan, the scaffold contract, and the scaffold's `bin/offense`
   all read three tops while the shipped contract reads three tops **plus `reports/`**. Source: both SOC/04
   texts, read whole, hashes above. **Confidence: certain.** Recommendation: widen to
   `evidence|findings|reports|SOC` and fix the scaffold's line — that is the reference's own wording.
6. **No manual exclude is needed for the manifest — the wider set is off by exactly one file.**
   `gate.py:140` drops it structurally (`have = [p for p in tree_files(root) if p != MANIFEST]`), so
   `walked 21 − manifest = 20` is the denominator the gate already prints. `hr-bot`'s `comm -13` delta of
   two collapses to one real artifact. Source: `python` walk of the four tops (21/20) + `:140`.
   **Confidence: certain.**
7. Reference run, unchanged after the patch: `gate.py ENG-2026-09-28-001` →
   `[1] PASS 19 OK / 19 rows, 0 FAILED, 0 unreadable (exit=0)`; `[3] PASS 0 Open (of 7 data rows)`;
   `[4] FAIL no phase-R artifact`; `[2] FAIL (coverage)` → `=> FAIL (coverage)`. Source: raw run.
   **Confidence: certain.**
8. **A gate report needs the cwd and the tree set in it, not a bare `n == n`.** Added to the skill's
   `## Reporting` (claim 4 is the worked example: two defensible readings of "19 files", one PASS and
   one FAIL). Source: the two counts above. **Confidence: certain.**
9. **UNVERIFIED:** that any other live board reads its manifest from a fourth root. No such engagement on
   this box; the clause covers it either way.

## Second defect, same family — check 3 read a false PASS (found on the live registry, 2026-09-28T10:0xZ)

10. **`gate.py`'s `Open` matcher was bare-cell-only and read `PASS 0 Open` on a registry carrying 2.**
    `ENG-2026-09-28-001/findings/FINDINGS_REGISTRY.md`: `grep -cE '\|\s*Open\s*\|'` → **0**,
    `grep -oE '\| `Open` \|' | wc -l` → **2** (contract cells are code-quoted), and the pre-patch gate
    printed `[3] STATUS PASS 0 Open (of 7 data rows)`. The skill's own bullet prescribed that same bare
    pattern. Fixed at `gate.py:155` → `\|\s*`?Open`?\s*\|`; the live run now reads
    `[3] STATUS FAIL 2 Open (of 7 data rows)`. No regression: `bluekit` (bare cells) still
    `FAIL 22 Open (of 50)`, `penttest` still `no findings/FINDINGS_REGISTRY.md`. Source: raw runs, all
    three legs. **Confidence: certain.** This is the same class as `bin/offense.py:825` — a
    reference-shaped prefix/cell matcher silently vacating on a contract-shaped tree.
11. **The manifest is now STALE — the reference "19 rows verify 19/19" is out of date.**
    `sha256sum -c` from the engagement root, same tree that read 19/19 PASS at ~10:0xZ earlier in this
    session: now `18 OK / 19 rows, 1 FAILED` — the failing row is
    `SOC/04_Evidence_and_Proof_Standard.md: FAILED`, and its mtime is **10:03:16** against a manifest
    sealed **09:30:31** (the `04bfdaa` contract re-pin landed after the seal). Cause is the edit, not
    lane A. Per the skill's own rule ("an unsealed edit is a FAIL, not a note"), the seal must be
    re-run before the card's 19/19 is quoted again. Source: `sha256sum -c` raw + `ls --time-style=full-iso`.
    **Confidence: certain.**
12. `offense-fleet` itself is live: `gate.py offense-fleet` → `20 manifest rows / 36 tree files;
    16 uncovered` (`evidence/raw/B_naabu.jsonl`, `B_naabu.out`, …) — the template is carrying lane
    B/C's writes, which is the scaffold-as-live-engagement call `boss-bot` put to the user. Source: raw
    run. **Confidence: certain.**

## Where the room's figures stand now

- `boss-bot`'s Phase-A gate re-run (`phase_A_osint.md` 56,654 B / 57 `## RAW-n` / 7 registry rows, 2
  `Open`): not re-run here — it is his probe, on the lane's artifact, and it is consistent with the
  manifest above (the phase-A evidence files are the manifest's 19 rows).
- `hr-bot`'s `tools/VERSIONS.md` re-pin (18 rows, `bcae8387…`): not re-run here; the fleet copy exists
  at the sha he quotes. **UNVERIFIED by me.**
