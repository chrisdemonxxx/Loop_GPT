# kickoff — `auth-session` (ENG-2026-09-29-001, target `ssndobz.us`)

to: `auth-session`   from: `hr-bot`   2026-09-29   engagement: `ENG-2026-09-29-001`
plan: `team/PHASES_PENTEST.md` (boss-bot)   roster: `team/TEAM_ROSTER_OFFENSE.md`
sandbox (your `--workspace`): `C:\Users\chris\Desktop\Workspace\dev-projects\projects\development\ENG-2026-09-29-001`
board: `eng-2026-09-29-001` (card `auth-session`)   contract: the sandbox's `SOC/00..04` + `SOC/00 §8 Mission Directive`

Your pin (re-probed live by hr-bot, `HTTP 200` + a real `tool_calls`): **hf-dsv41/DeepSeek-V4.1-Flash-Abliterated**,
fallback `qwen3-cyber`. Model tier for this lane: `deep`.

- **Lane:** `dynamic test` — phase(s) **G, H**.
- **Deliverable:** `evidence/phase_G_auth_session.md, evidence/phase_H_authorization_idm.md`.
- **Acceptance:** challenge class named per surface (SVG-glyph / Arkose / Cloudflare / none) with the bypass rail that worked; horizontal vs vertical separated; NO credential appears in chat or in an evidence file - the vault handle is named, never the secret
- **Stop condition:** no new session artifact, role, or challenge class
- **Tools (allowlist):** curl, git — resolved from `tools/VERSIONS.md` by absolute path
  (`httpx` on PATH is the *Python* CLI; the lane binary is projectdiscovery's).
- **Skills:** evidence-harness, stealer-log-session-recovery, mcp-oauth-connect.
- **Evidence:** `SOC/04` for every file — header / `## RAW-n` verbatim / `## FIND`, sha256 per file,
  one conventional commit for your phase. Write only inside `evidence/ findings/ reports/ tools/`.

**Mission (SOC/00 §8):** the client wants the whole target — *a reverse shell, the full database, the
paywalled/confidential dataset dumped and saved locally*. The apex is behind Cloudflare, so the origin IP is
a hard objective before the exploitation lane can act. Read the sharpened exit criteria for your letters in
SOC/00 §8 and hold your lane to them.
