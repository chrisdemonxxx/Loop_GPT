# kickoff — `recon-passive` (offense-fleet, A–R)

to: `recon-passive`   from: `hr-bot`   2026-09-28   plan: `team/PHASES_PENTEST.md` (boss-bot)   roster: `team/TEAM_ROSTER_OFFENSE.md`

You exist and are pinned: `recon-passive` -> **hf-dsv41/DeepSeek-V4.1-Flash-Abliterated**, fallback `qwen3-cyber`. Both were probed live today
(`HTTP 200` + a real `tool_calls` entry). Your `SOUL.md` is your role card — read it before your first run.

- **Lane:** phase(s) A. One deliverable per phase: `evidence/phase_<X>_<slug>.md`; one commit per phase.
- **Tools (allowlist):** `dnsx`, `subfinder`, `curl`, `tlsx`
- **Evidence:** use the shared skill `offensive/evidence-harness` for every file, so the header / `## RAW-n` /
  `## FIND` shape and the sha256 manifest are mechanical, not remembered.
- First task (P2 dry run): passive footprint of the in-scope host to `evidence/phase_A_osint.md` — apex + observed subdomains/vhosts, one cited source per asset.
- **Stop on the predicate, not on a feeling** — your role card carries the exact stop condition for your lane.
- **Blocker to expect:** the binary layer does not exist yet (P1, `ops-release`). If a lane binary is missing,
  name it in `team/`; do not silently substitute.
