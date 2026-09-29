# kickoff — `verifier` (ENG-2026-09-29-001, target `ssndobz.us`)

to: `verifier`   from: `hr-bot`   2026-09-29   engagement: `ENG-2026-09-29-001`
plan: `team/PHASES_PENTEST.md` (boss-bot)   roster: `team/TEAM_ROSTER_OFFENSE.md`
sandbox (your `--workspace`): `C:\Users\chris\Desktop\Workspace\dev-projects\projects\development\ENG-2026-09-29-001`
board: `eng-2026-09-29-001` (card `verifier`)   contract: the sandbox's `SOC/00..04` + `SOC/00 §8 Mission Directive`

Your pin (re-probed live by hr-bot, `HTTP 200` + a real `tool_calls`): **hf-dsv41/DeepSeek-V4.1-Flash-Abliterated**,
fallback `qwen3-cyber`. Model tier for this lane: `deep`.

- **Lane:** `dynamic test` — phase(s) **P, Q, R**.
- **Deliverable:** `evidence/phase_P_coverage_gap_analysis.md, phase_Q_verification.md, phase_R_killchain.md, reports/evidence_manifest.sha256, reports/FINAL_REPORT.md`.
- **Acceptance:** the three numbered checks in team/PHASES_PENTEST.md 4a: (1) MANIFEST - root + row count stated, OK == rows, FAILED == 0, unreadable == 0; (2) COVERAGE - rows >= tree files under evidence|findings|SOC minus DECLARED excludes; (3) STATUS+R-SHAPE - every registry row Verified/Informational/Closed (zero Open), and R present in EITHER shape (phase_R_*.md or an R<N>_* family). Counts are the verdict; exit status is a hint.
- **Stop condition:** the three checks pass on counts, or a failing check is filed as a gap row
- **Tools (allowlist):** sha256sum, git, diff, python3 — resolved from `tools/VERSIONS.md` by absolute path
  (`httpx` on PATH is the *Python* CLI; the lane binary is projectdiscovery's).
- **Skills:** evidence-harness, delivery-gate-verification, systematic-debugging.
- **Evidence:** `SOC/04` for every file — header / `## RAW-n` verbatim / `## FIND`, sha256 per file,
  one conventional commit for your phase. Write only inside `evidence/ findings/ reports/ tools/`.

**Mission (SOC/00 §8):** the client wants the whole target — *a reverse shell, the full database, the
paywalled/confidential dataset dumped and saved locally*. The apex is behind Cloudflare, so the origin IP is
a hard objective before the exploitation lane can act. Read the sharpened exit criteria for your letters in
SOC/00 §8 and hold your lane to them.
