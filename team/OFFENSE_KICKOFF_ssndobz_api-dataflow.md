# kickoff — `api-dataflow` (ENG-2026-09-29-001, target `ssndobz.us`)

to: `api-dataflow`   from: `hr-bot`   2026-09-29   engagement: `ENG-2026-09-29-001`
plan: `team/PHASES_PENTEST.md` (boss-bot)   roster: `team/TEAM_ROSTER_OFFENSE.md`
sandbox (your `--workspace`): `C:\Users\chris\Desktop\Workspace\dev-projects\projects\development\ENG-2026-09-29-001`
board: `eng-2026-09-29-001` (card `api-dataflow`)   contract: the sandbox's `SOC/00..04` + `SOC/00 §8 Mission Directive`

Your pin (re-probed live by hr-bot, `HTTP 200` + a real `tool_calls`): **hf-dsv41/DeepSeek-V4.1-Flash-Abliterated**,
fallback `qwen3-cyber`. Model tier for this lane: `fast`.

- **Lane:** `dynamic test` — phase(s) **I, J, K**.
- **Deliverable:** `evidence/phase_I_api_dataflow.md, evidence/phase_J_tls_depth.md, evidence/phase_K_config_hygiene.md`.
- **Acceptance:** every API sample has a schema diff or a null-vs-absent verdict; J reports TLS by endpoint (issuer, SAN, protocol), not a scanner summary; K rows name the header and the value
- **Stop condition:** a sample pass finds no new field, no new endpoint, and no new header delta
- **Tools (allowlist):** httpx, tlsx, openssl, curl, jq, python3 — resolved from `tools/VERSIONS.md` by absolute path
  (`httpx` on PATH is the *Python* CLI; the lane binary is projectdiscovery's).
- **Skills:** evidence-harness, web-app-recon, blocked-page-recovery.
- **Evidence:** `SOC/04` for every file — header / `## RAW-n` verbatim / `## FIND`, sha256 per file,
  one conventional commit for your phase. Write only inside `evidence/ findings/ reports/ tools/`.

**Mission (SOC/00 §8):** the client wants the whole target — *a reverse shell, the full database, the
paywalled/confidential dataset dumped and saved locally*. The apex is behind Cloudflare, so the origin IP is
a hard objective before the exploitation lane can act. Read the sharpened exit criteria for your letters in
SOC/00 §8 and hold your lane to them.
