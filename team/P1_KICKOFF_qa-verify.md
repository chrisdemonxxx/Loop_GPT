# P1 KICKOFF — qa-verify (owner: the GAP-003 axe sweep)

**Deliverable: `team/A11Y_AXE.md`.**

The suite you own already exists: `frontend/tests/e2e/app.spec.ts` — `AxeBuilder` runs over
`/`, `/login/`, `/signup/` + the chat shell, but the gate filters to `impact === 'critical'` **only**
(lines 10–13, with the comment "`serious` contrast issues are tracked in the design pass (GAP-003)").
That sweep is the deliverable.

Acceptance — a table, no prose verdict:
- every route in the static export (`find frontend/out -name '*.html'` → 18 pages; the build route table
  in `team/PERF_BASELINE.md` lists the 19 routes) × **both themes** (dark is the default; the boot
  script at `out/*/index.html` applies a stored `loop-theme`, and `tests/e2e/app.spec.ts:43` already
  drives the light theme);
- every `serious` or `critical` violation: `rule id | element (CSS selector + the offending HTML) | the
  computed contrast ratio axe reports | theme | route`;
- a machine-readable dump beside it (`axe-results-<theme>.json`) — commit the JSON, not a screenshot;
- the count of `moderate` violations per route, so we can see the tail.

Then: tighten the gate from `critical` to `serious` in `tests/e2e/app.spec.ts` (your file) **only after**
the violations it would catch are either fixed or explicitly waived with a ratio line in the report.
`npm run test:browser` must stay `20 passed`-green on the frozen revision, or the pass count changes and
you say by how much.

Reference point, already real: the frozen revision `7540a3d` passes `tsc`=0, `lint`=0 (13 warn),
`vitest` 23 files/150 tests, `playwright` 20 passed, `build` exit 0 — see `team/P0_CLOSEOUT.md` §2.
A green suite is necessary, not sufficient: contrast is exactly the class of thing a green `critical`-only
suite hides.

Blocked? One line: what, and the unblocker.
