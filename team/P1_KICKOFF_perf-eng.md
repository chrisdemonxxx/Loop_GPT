# P1 KICKOFF — perf-eng (owner: perf bundle budget)

Frozen revision for reference: `7540a3d` (see `team/P0_CLOSEOUT.md`). Baseline: `team/PERF_BASELINE.md`
(6,059 B, sha256 `5015e199…`) — that file is yours, keep it, don't rewrite it.

**Deliverable: `team/PERF_P1.md`.** Baseline FIRST (already done), then fixes, each with a
**before/after number measured by the same command**.

Acceptance — no line without a raw command beside a raw result:
- `npm run build` route table before vs after (the `/chat` first-load JS number is the headline: **505 kB**).
- gzip bytes per chunk for the chunk(s) you touch, before vs after (`gzip -9 -c | wc -c`).
- Live timings before vs after: 5× `curl -s -o /dev/null -w '%{time_total}' https://loop-gpt.cyou/chat/`.
- LCP / CLS / TBT on `/` and `/chat` from a real browser (Playwright is installed; use it, don't estimate).
- First-token latency on a real model call (the `?prompt=` run your baseline names as `PERF_TTFT_<model>.md`).

Ranked offenders to attack, from your own baseline (fix order = biggest first):
1. **mermaid** — `elk.js` 1.45 MB + 654 KB + 432 KB loaded **unconditionally**; ≈2.5 MB raw / ~692 kB gzip
   on every `/chat` first-load. Fix: `dynamic(() => import('mermaid'))` behind a rendered
   `<pre class="mermaid">`. This is the single largest win on the board.
2. **xlsx (SheetJS)** 414 KB on first-load — dynamic import in the export path.
3. **highlight.js** 387 KB — register only the languages in use.
4. **elk.js worker** — instantiate only after the first layout.
5. **framer-motion** duplicated across message chunks — `m` component, not the full tree.

**Ownership:** you own perf files. `frontend/app/components/chat/MessageBubble.tsx` and
`MessageList.tsx` are in `ui-visual`'s blast radius — hand off in one line in the room before editing,
or land your change as an import-level swap that does not touch their render logic.

Blocked? One line in the room + in your report: what, and the unblocker.
