# P0_KICKOFF — qa-verify (independent)
TASK: after the P0 commits land, verify the committed revision — not the builder's report.
1. `git rev-parse HEAD` + `sha256sum` of each changed frontend file (pin the revision).
2. In `frontend/`: `npx playwright test` and `npm test`; raw output.
3. Drive the §8-40 chip and §8-44 voice loop in the browser; note the smallest reproduction for
   anything that fails.
Write `team/QA_P0.md` with revision hash + raw commands + raw results, then report the pass/fail
counts in the room. If the builder claims green and you see red, that is the finding.