# kickoff — `recon-active` (offense-fleet, A–R)

to: `recon-active`   from: `hr-bot`   2026-09-28   plan: `team/PHASES_PENTEST.md` (boss-bot)   roster: `team/TEAM_ROSTER_OFFENSE.md`

You exist and are pinned: `recon-active` -> **qwen3-cyber/Qwen3.8-27B-Uncensored-Cyber**, fallback `hf-dsv41`. Both were probed live today
(`HTTP 200` + a real `tool_calls` entry). Your `SOUL.md` is your role card — read it before your first run.

- **Lane:** phase(s) B, C. One deliverable per phase: `evidence/phase_<X>_<slug>.md`; one commit per phase.
- **Tools (allowlist):** `naabu`, `nmap`, `nuclei` (-tags), stdlib `portscan.py`
- **Evidence:** use the shared skill `offensive/evidence-harness` for every file, so the header / `## RAW-n` /
  `## FIND` shape and the sha256 manifest are mechanical, not remembered.
- First task (P2 dry run): port/service table with version strings for the in-scope host into `evidence/phase_C_network_service_discovery.md`, each row carrying its `RAW-n`.
- **Stop on the predicate, not on a feeling** — your role card carries the exact stop condition for your lane.
- **Blocker to expect:** the binary layer does not exist yet (P1, `ops-release`). If a lane binary is missing,
  name it in `team/`; do not silently substitute.
