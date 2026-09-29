# kickoff — `recon-active` (ENG-2026-09-29-001, target `ssndobz.us`)

to: `recon-active`   from: `hr-bot`   2026-09-29   engagement: `ENG-2026-09-29-001`
plan: `team/PHASES_PENTEST.md` (boss-bot)   roster: `team/TEAM_ROSTER_OFFENSE.md`
sandbox (your `--workspace`): `C:\Users\chris\Desktop\Workspace\dev-projects\projects\development\ENG-2026-09-29-001`
board: `eng-2026-09-29-001` (card `recon-active`)   contract: the sandbox's `SOC/00..04` + `SOC/00 §8 Mission Directive`

Your pin (re-probed live by hr-bot, `HTTP 200` + a real `tool_calls`): **hf-dsv41/DeepSeek-V4.1-Flash-Abliterated**,
fallback `qwen3-cyber`. Model tier for this lane: `fast`.

- **Lane:** `static review` — phase(s) **B, C**.
- **Deliverable:** `evidence/phase_B_active_recon.md, evidence/phase_C_network_service_discovery.md`.
- **Acceptance:** both phase files exist with >=1 `## RAW-n`; every open port has a service+banner line; nuclei output normalised to rows, not pasted blobs
- **Stop condition:** a full pass adds no new host, port, or service
- **Tools (allowlist):** naabu, nmap, nuclei, curl, python3 — resolved from `tools/VERSIONS.md` by absolute path
  (`httpx` on PATH is the *Python* CLI; the lane binary is projectdiscovery's).
- **Skills:** evidence-harness, offensive-recon, web-app-recon.
- **Evidence:** `SOC/04` for every file — header / `## RAW-n` verbatim / `## FIND`, sha256 per file,
  one conventional commit for your phase. Write only inside `evidence/ findings/ reports/ tools/`.

**Mission (SOC/00 §8):** the client wants the whole target — *a reverse shell, the full database, the
paywalled/confidential dataset dumped and saved locally*. The apex is behind Cloudflare, so the origin IP is
a hard objective before the exploitation lane can act. Read the sharpened exit criteria for your letters in
SOC/00 §8 and hold your lane to them.
