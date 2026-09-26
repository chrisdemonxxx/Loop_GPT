# P0_KICKOFF — boss-bot (Orchestrator)
Read `team/P0_KICKOFF.md`. You own the ledger.
TASK (bounded, do it now): write `team/PHASES.md` from the roadmap in the kickoff, with columns
`phase | owner | deliverable | acceptance | status`. Status must be filesystem-verified, not assumed:
for every "shipped" line, name the file path you read and one raw command result behind it.
Then verify the two open claims in `TEAM_ROSTER.md` §4 yourself: (a) `git status --short` — the
13 in-flight entries; (b) `cd frontend && npx tsc --noEmit` → exit code. Report both raw.
Write the file, then post one line in the room: the phase count, the P0 owner, and the raw tsc
exit code you observed.