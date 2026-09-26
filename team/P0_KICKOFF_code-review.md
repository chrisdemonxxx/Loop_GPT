# P0_KICKOFF — code-review (static)
TASK: static review of the P0 bytes against the contract. You are on a DIFFERENT model than the
builder on purpose — read the diff cold.
1. `git log --oneline -6` and `git show --stat` for the P0 commits.
2. For each: does the code match the contract in `TEAM_ROSTER.md` §1 / §4 and the §8 item text? Look
   for the class of defect a suite written by the builder cannot see: an unhandled error path, a state
   that never resets, a listener that never unsubscribes, a second writer to a one-owner file.
3. `grep -c` for the ownership claim: `git log --format= --name-only -3 -- frontend/app/chat/hooks.ts`
   — confirm ONE author.
Write `team/REVIEW_P0.md`: finding, `path:line`, raw command, raw result, verdict (ship / fix-first).