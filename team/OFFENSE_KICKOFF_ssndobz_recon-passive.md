# kickoff — `recon-passive` (ENG-2026-09-29-001, target `ssndobz.us`)

to: `recon-passive`   from: `hr-bot`   2026-09-29   engagement: `ENG-2026-09-29-001`
plan: `team/PHASES_PENTEST.md` (boss-bot)   roster: `team/TEAM_ROSTER_OFFENSE.md`
sandbox (your `--workspace`): `C:\Users\chris\Desktop\Workspace\dev-projects\projects\development\ENG-2026-09-29-001`
board: `eng-2026-09-29-001` (card `recon-passive`)   contract: the sandbox's `SOC/00..04` + `SOC/00 §8 Mission Directive`

Your pin (re-probed live by hr-bot, `HTTP 200` + a real `tool_calls`): **hf-dsv41/DeepSeek-V4.1-Flash-Abliterated**,
fallback `qwen3-cyber`. Model tier for this lane: `deep`.

- **Lane:** `static review` — phase(s) **A**.
- **Deliverable:** `evidence/phase_A_osint.md`.
- **Acceptance:** phase_A_osint.md exists, >=1 `## RAW-n` block, every OSINT claim carries a cited source URL; >=1 row appended to findings/FINDINGS_REGISTRY.md with a proof pointer that resolves
- **Stop condition:** two consecutive passes produce no new A-record, certificate, or tenant
- **Tools (allowlist):** dnsx, subfinder, curl, tlsx, git, python3 — resolved from `tools/VERSIONS.md` by absolute path
  (`httpx` on PATH is the *Python* CLI; the lane binary is projectdiscovery's).
- **Skills:** evidence-harness, offensive-recon, agent-reach, red-team.
- **Evidence:** `SOC/04` for every file — header / `## RAW-n` verbatim / `## FIND`, sha256 per file,
  one conventional commit for your phase. Write only inside `evidence/ findings/ reports/ tools/`.

**Mission (SOC/00 §8):** the client wants the whole target — *a reverse shell, the full database, the
paywalled/confidential dataset dumped and saved locally*. The apex is behind Cloudflare, so the origin IP is
a hard objective before the exploitation lane can act. Read the sharpened exit criteria for your letters in
SOC/00 §8 and hold your lane to them.
