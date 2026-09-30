# DISPATCH — the *UI Schema Cloning Blueprint* (803 lines, §0–§17 + Addendum A) across the fleet

**From:** `boss-bot` (orchestrator) · **To:** the roster (`TEAM_ROSTER.md` §2, rev 9)
**Filed:** 2026-09-29 21:45 EDT · HEAD `4f707bd`, branch `release/owned-staging-20260917` (0 ahead).
**Spec:** the pasted file, hash-verified before this dispatch:
`C:\Users\chris\AppData\Local\hermes\profiles\hr-bot\attachments\pasted_content_2026-09-30_01-33-49-089_949f58.txt`
→ 802 lines, 53,385 B, sha256 `69d50c79220bb2ed7732969fc569ebd1b8928691c073b00a18bb01a11621038e`.
**Answers:** `team/NOTE_blueprint_roster_hr-bot.md` §6 (the two open rows) — both ruled below.

---

## 0. Verified on disk this pass (not taken on report)

```
$ for r in recents projects artifacts customize downloads upgrade buying-specialist code; do p=frontend/app/$r/page.tsx; \
    [ -e "$p" ] && echo "OK $p" || echo "MISS $p"; done
MISS frontend/app/recents/page.tsx … MISS frontend/app/code/page.tsx      # 8/8 MISS (9th: artifact/:id)
$ ls frontend/tokens.json frontend/.storybook ; grep -c storybook frontend/package.json
MISS frontend/tokens.json   MISS frontend/.storybook   0
$ ls frontend/tests/e2e/    →  app.spec.ts            # the §15 harness and the §13 parity spec are absent
$ ls -l ~/.local/bin/pixel-measure.bat → 41 B ; hermes profile list | grep pixel-measure
  pixel-measure   s-zaizen/DeepSeek-V4.1-Fla   stopped   pixel-measure —      # profile is real, not a listing
```
hr-bot's §2/§3 map reproduces on every path I re-checked. Nothing in §1 needs re-litigating; both live seats
probe `TOOLS_OK`.

---

## 1. RULING 1 — `pixel-measure`: **CONFIRMED**. Slot = blueprint §3 **P1**, carried on the loop-gpt ledger as **P6**, beside the in-flight ledger P5.

The blueprint makes measurement its own precondition: §1.3 (`≤0.5% pixel delta`), §15 (`tokens.json`,
baseline set), §16. The ledger's P5 is the mobile rect gate and is already `ui-visual`'s; measurement runs
on HEAD's existing screens now, so it does not queue behind P5. Boundary, read-only on `frontend/app/**`:
owns `frontend/tokens.json`, `frontend/tests/baselines/**`, `frontend/tests/e2e/visual-parity.spec.ts`,
`team/VISUAL_PARITY.md`; `qa-verify` keeps `app.spec.ts`. **Declined** the fold-into-`qa-verify`
alternative: that route needs a second Playwright project *and* a different instrument (computed styles +
stills), which is a seat, not a config line. Kickoff: `team/P6_KICKOFF_pixel-measure.md`.

## 2. RULING 2 — Storybook: **CUT a second seat `storybook-dev`** (slot: blueprint **P0**).

P0's exit criterion is literally *"CI green"* and §10 requires stories for ~25 components; folding it into
`ui-visual` puts the P0 gate behind nine missing route trees, the 12-panel settings dialog and the in-flight
P5 fix — P0 becomes unclosable. Seam: `storybook-dev` owns `.storybook/**`, `frontend/components/**/*.stories.tsx`
and the `@storybook/*` dev-deps in `frontend/package.json` (one hand-off line); `ui-visual` keeps every
component `.tsx`. **Precondition (dependency, not a blocker):** `hr-bot` cuts the seat exactly as `pixel-measure`
was cut — `hermes profile create --clone-from ui-visual storybook-dev`, alias wrapper, role card, and a proving
turn (`SEAT-OK`); primary `hf-dsv41`, fallback `qwen3-cyber` (≠ its own primary, and ≠ `ui-visual`'s model
by the diversity rule). Kickoff: `team/P6_KICKOFF_storybook-dev.md`.

## 3. RULING 3 (standing) — the blueprint is a **parity target on the existing stack**, not a rebuild.

§2 offers "Vite **or** Next.js App Router"; loop-gpt is Next.js 14 static-export in `frontend/` and
`web/Dockerfile` + `web/nginx.template.conf` is the LIVE deploy path. No new repo, no Vite migration, no
second app. `ui-visual` owns that call. **Naming rule:** every artifact carries `BP Pn` (blueprint) or
`ledger Pn` (loop-gpt board) — the two P0–P6 numbering schemes are *not* the same and the ledger's
in-flight P5 is untouched by this dispatch.

## 4. The dispatch — blueprint phase → seat → acceptance in measurable units → the file the seat writes

| BP phase | seat | acceptance (measurable units) | file the seat writes |
|---|---|---|---|
| **BP P0** infra/CI/Storybook | `storybook-dev` (+ `pixel-measure` on the token pipeline) | `npx build-storybook` exit 0; 25 `*.stories.tsx` on disk; CI job green on a clean tree | `frontend/.storybook/main.ts` + `preview.ts`, `frontend/components/**/*.stories.tsx`, `frontend/package.json` (dev-deps) |
| **BP P1** measurement → **ledger P6** | `pixel-measure` | `tokens.json` light **and** dark; baseline stills at 1440×900 / 1280×800 / 820×1180 / 390×844; per-screen diff `maxDiffPixelRatio ≤ 0.005`; a11y-tree snapshot diff = 0; byte counts + sha256 pasted | `frontend/tokens.json`, `frontend/tests/baselines/**`, `frontend/tests/e2e/visual-parity.spec.ts`, `team/VISUAL_PARITY.md` |
| **BP P2** app shell | `ui-visual` (+ `arch-lead` for the A3 prefs schema) | shell diff ≤ 0.5% at 1440×900 and 390×844; sidebar width/collapsed + theme survive a reload; prefs schema carries an explicit version field | `frontend/components/Sidebar.tsx`, `frontend/lib/uiPrefs.ts`; `team/CONTRACT_P2_PREFS.md` (`arch-lead`) |
| **BP P3** composer + menus (+A3 attachments, speech) | `ui-visual`, `core-dev` | composer story + a11y snapshot match; attachment chips render `uploading`/`ready`/`error` each with progress; chips == files dropped (drag-drop) | `frontend/components/chat/Composer.tsx`, `frontend/app/chat/composer/*.tsx`; `backend/src/routes/attachments.ts` |
| **BP P4** chat page (+A3 SSE, stop/regen, branching, read-aloud) | `ui-visual` (render), `core-dev` (stream/branch) | stream renders incrementally; stop leaves the partial; regenerate yields version N+1 and `Message N of M` == `MessageVersion`; 0 unhandled abort errors | `frontend/components/chat/{MessageList,MessageBubble,TurnActivity}.tsx`; `backend/src/routes/agent.ts` |
| **BP P5** palette + menus (+A3 toast/tooltip/shortcut registry) | `ui-visual` | cheat sheet lists **100%** of `frontend/lib/shortcuts.ts` entries; toast stack order + ttl asserted; palette opens on every route | `frontend/components/CommandPalette.tsx`, `frontend/lib/{toast,shortcuts}.ts`, `frontend/components/ShortcutCheatSheet.tsx` |
| **BP P6** settings (12 panels + Privacy) | `ui-visual` | all 12 panels + privacy sub-panels reachable by hash; each populated **and** in an error state; confirm dialogs for delete-account / log-out-all | `frontend/components/SettingsPanel.tsx`, `frontend/components/settings/*.tsx` |
| **BP P7** projects/artifacts/recents/customize/detail | `ui-visual`, `core-dev` | 5 route trees render empty + populated; install/manage round-trip persists; permission-table rows == connector tools in the catalog | `frontend/app/{projects,artifacts,recents,customize}/page.tsx` + `frontend/components/customize/*.tsx`; `backend/src/routes/{projects,connectors}.ts` |
| **BP P8** downloads/upgrade/code/buying-specialist (+A3 entitlement) | `arch-lead` → `core-dev` → `ui-visual` | plan × feature matrix (Free / Pro / Max / Team) asserts 100% of cells; one `<UpgradeGate feature="code"/>` reused by Code, Design system, model rows | `team/CONTRACT_ENTITLEMENT.md` → `backend/src/services/entitlements.ts` + `frontend/components/UpgradeGate.tsx` |
| **BP P9** artifact detail + sandboxed iframe (+A3 share/deep-link/incognito) | `arch-lead` + `core-dev`, `ui-visual` | body renders in a cross-origin `*.frame.<sandbox-domain>` iframe; parent cannot reach the child document (assert throws); share page carries no authenticated chrome | `web/nginx.template.conf` (sandbox map), `frontend/app/artifact/[id]/page.tsx`, `frontend/components/ArtifactViewers.tsx` |
| **BP P10** responsive/dark/motion + regression lock | `ui-visual` + `pixel-measure` (lock) | reduced-motion + one RTL snapshot pass; 404 / offline / skeleton states render; diff budget met at **all** viewports on the frozen revision | `frontend/app/globals.css` (tokens/motion), `frontend/tests/e2e/visual-parity.spec.ts` (lock at freeze) |
| **A §A4 M-01…M-25** | `web-cartographer` (no hire — seat exists) | a task is `VERIFIED` only with the 5-part set (a11y dump, light+dark stills, href/hash list, keyboard notes, computed styles); one ledger row per task | `team/MAPPING_LEDGER.md` + `team/mapping/M-XX_*` |
| **§13 + §11 verification** | `qa-verify` | a11y-tree parity snapshot diff = 0 on every route; keyboard parity row per shortcut in §11; `app.spec.ts` stays theirs | `frontend/tests/e2e/a11y-parity.spec.ts` |
| **A3 rows** | *folded into the phase above each one names* (P2 prefs → arch-lead; P3 attachments; P4 stream; P5 toasts/registry; P6 panels; P7 detail; P8 entitlement; P9 share; P10 i18n/RTL/404) | the A3 line's own test, run: attachment error paths, stream cancel, branching pager, entitlement matrix, toast stacking, reduced-motion, RTL snapshot, offline banner | the same files as the host phase |

**A4's task lane is read-only by default** (`web-cartographer`), on a throwaway account for the destructive
tasks; it never enters payment data. A5 is the close gate: every A1/A2 `UNMAPPED`/`ASSUMED` row becomes
`VERIFIED` (5-part evidence) or `OUT OF SCOPE` with a reason — the row is `web-cartographer`'s, the
verdict is `code-review`'s.

## 5. NOT dispatched, and why

| seat | not on the blueprint, because | stays on |
|---|---|---|
| `mobile-dev` | the blueprint's §4 route table is web-only — no `mobile/` surface anywhere | the ledger's mobile mirror |
| `perf-eng` | BP §1.3 budgets **pixels**, not time; the blueprint has no perf phase | ledger P1's `PERF_P1.md` (still the oldest open artifact) |
| `ops-release` | the blueprint has no release phase; the clone's deploy is the existing pipeline | ledger P4/P5: deploy + `/version.json` read-back (`GIT_REVISION` still unset) |
| `research-scout` | the blueprint is a spec, not a recon target; external ground truth only fires on an A1.3 contradiction | ledger recon |
| `code-review` | not a phase owner — its verdict is pinned per phase freeze | every BP phase freeze (static lane first, per the board's lane order) |

Nothing else is withheld: every blueprint surface in hr-bot's §2 map has a named seat above.
