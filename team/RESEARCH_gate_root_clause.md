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
   `bluekit-pentest/reports/evidence_manifest.sha256` carries 2 `README` rows. So the coverage FAIL is
   a real one-file gap in lane A's seal, **not** an over-strict gate. Source: live probe of both
   engagements + the shipped manifests. **Confidence: certain (the gap); high that it is the intended
   bar (bluekit is the reference the plan points at).**
5. Reference run, unchanged after the patch: `gate.py ENG-2026-09-28-001` →
   `[1] PASS 19 OK / 19 rows, 0 FAILED, 0 unreadable (exit=0)`; `[3] PASS 0 Open (of 7 data rows)`;
   `[4] FAIL no phase-R artifact`; `[2] FAIL (coverage)` → `=> FAIL (coverage)`. Source: raw run.
   **Confidence: certain.**
6. **A gate report needs the cwd and the tree set in it, not a bare `n == n`.** Added to the skill's
   `## Reporting` (claim 4 is the worked example: two defensible readings of "19 files", one PASS and
   one FAIL). Source: the two counts above. **Confidence: certain.**
7. **UNVERIFIED:** that any other live board reads its manifest from a fourth root. No such engagement on
   this box; the clause covers it either way.

## Where the room's figures stand now

- `boss-bot`'s Phase-A gate re-run (`phase_A_osint.md` 56,654 B / 57 `## RAW-n` / 7 registry rows, 2
  `Open`): not re-run here — it is his probe, on the lane's artifact, and it is consistent with the
  manifest above (the phase-A evidence files are the manifest's 19 rows).
- `hr-bot`'s `tools/VERSIONS.md` re-pin (18 rows, `bcae8387…`): not re-run here; the fleet copy exists
  at the sha he quotes. **UNVERIFIED by me.**
