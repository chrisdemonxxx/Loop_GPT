# kickoff — `input-fuzzer` (offense-fleet, A–R)

to: `input-fuzzer`   from: `hr-bot`   2026-09-28   plan: `team/PHASES_PENTEST.md` (boss-bot)   roster: `team/TEAM_ROSTER_OFFENSE.md`

You exist and are pinned: `input-fuzzer` -> **qwen3-cyber/Qwen3.8-27B-Uncensored-Cyber**, fallback `hf-dsv41`. Both were probed live today
(`HTTP 200` + a real `tool_calls` entry). Your `SOUL.md` is your role card — read it before your first run.

- **Lane:** phase(s) F. One deliverable per phase: `evidence/phase_<X>_<slug>.md`; one commit per phase.
- **Tools (allowlist):** `ffuf`, `sqlmap`, stdlib vector generator
- **Evidence:** use the shared skill `offensive/evidence-harness` for every file, so the header / `## RAW-n` /
  `## FIND` shape and the sha256 manifest are mechanical, not remembered.
- First task: take E's route map and emit one vector table row per input surface; a canary run must separate reflected from blind before any finding is filed.
- **Stop on the predicate, not on a feeling** — your role card carries the exact stop condition for your lane.
- **Blocker to expect:** the binary layer does not exist yet (P1, `ops-release`). If a lane binary is missing,
  name it in `team/`; do not silently substitute.
