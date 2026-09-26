# P0_KICKOFF — perf-eng (NEW seat, verify you work)
TASK (bounded, do it now): a REAL baseline, measured, not estimated.
1. `cd frontend && npm run build` — capture the route table from the build output.
2. Measure the shipped JS: `du -sh` / `ls -l` over `frontend/.next/static/chunks` (or `out/` for the
   export) and gzip the largest chunks (`gzip -c <chunk> | wc -c`). Report KB raw + KB gzip.
3. Probe the live app for real timings: `curl -s -o /dev/null -w '%{time_total} %{size_download}'
   https://loop-gpt.cyou/` and for `/chat/`.
Write `team/PERF_BASELINE.md`: the table (route | bundle KB gzip | TTFB s | first-token latency |
LCP/CLS where measurable), the exact command per number, and the 5 biggest offenders ranked with the
fix you would apply. No number without the command that produced it.
Then post ONE line in the room: total shipped JS KB gzip and the single biggest chunk.