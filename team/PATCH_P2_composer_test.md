# team/PATCH_P2_composer_test.md — the red P2 gate, and the 3-edit fix that turns it green

**Filed by `boss-bot` (orchestrator), 2026-09-28T00:49Z.** HEAD `a4b29bbaaf1349c694b54c0efe9e1140a8bb9d37`.
Owner of the file under repair, per `team/CONTRACT_P2_STREAM.md` §E (`tests … → qa-verify`): **`qa-verify`**.
Nothing else in the working tree needs to change for the gate to go green.

## 1. The gate, re-run by the orchestrator on the working tree (not on a report)

```
$ cd frontend && npx tsc --noEmit; echo TSC_EXIT=$?
app/components/chat/__tests__/Composer.test.tsx(153,41): error TS2353: Object literal may only
specify known properties, and 'onToggle' does not exist in type 'Partial<{ … }>'.
TSC_EXIT=2

$ npx vitest run
 Test Files  1 failed | 22 passed (23)
      Tests  1 failed | 150 passed (151)
   × Composer > effort selector: all six positions, xhigh carries the 8k cap, pick dispatches 25ms
     → Unable to find an element with the title: /^Reasoning effort: XHighhigh /.
```

Both failures are in **one file**, `frontend/app/components/chat/__tests__/Composer.test.tsx`
(5,978 B-class test, mtime 19:30 EDT). The component under test — `composer/EffortSelector.tsx`
(5,978 B, sha256 `ff5723b0acd0945b2b62a96fb90afe4e554fb7a404fd2fb15072b9c1b855db70`) — is **correct**:
its six labels are `Auto/Low/Medium/High/XHigh/Off` (`THOUGHT_EFFORTS`, `:18-25`) and it renders
`role="menuitem"` + `aria-label="Reasoning effort: ${label}"` (`:99-105`). Three test-side defects,
each verified by isolation:

| # | defect | proof |
|---|---|---|
| 1 | prop name `onToggle` — the prop is `onToggleThinking` (`Composer.tsx:28-29`) | `tsc` TS2353 at `:153`; `page.tsx:615` passes `onToggleThinking` |
| 2 | `cap('xhigh')` → **`"XHighhigh"`**: `s.replace(/^(.)/, (m,c)=> c==='x' ? 'XHigh' : c.toUpperCase())` substitutes the whole `XHigh` for the first char | the failing assertion's own message: `/^Reasoning effort: XHighhigh /` |
| 3 | the dispatch loop assumes the menu stays open, but `pick()` closes it by design (`EffortSelector.tsx:68` `setOpen(false)`) | after fix 1+2 the failure moved to `role "menuitem" name "Reasoning effort: Low"` — i.e. the menu was shut after the `auto` pick |

## 2. The fix (3 edits, all inside `it('effort selector: all six positions…')`)

```diff
-    renderComposer({ thinking: 'xhigh', onToggle })
+    renderComposer({ thinking: 'xhigh', onToggleThinking: onToggle })

-    const cap = (s: string) => s.replace(/^(.)/, (m, c) => c === 'x' ? 'XHigh' : c.toUpperCase())
+    const cap = (s: string) => ({ auto: 'Auto', low: 'Low', medium: 'Medium', high: 'High',
+      xhigh: 'XHigh', off: 'Off' } as Record<string, string>)[s]

-      const title = new RegExp(`^Reasoning effort: ${cap(id)} `)
-      expect(screen.getByTitle(title)).toBeInTheDocument()
+      expect(screen.getByRole('menuitem', { name: `Reasoning effort: ${cap(id)}` })).toBeInTheDocument()

-      const item = screen.getByTitle(new RegExp(`^Reasoning effort: ${cap(next)} `))
+      // pick() closes the menu by design (§A) — re-open before each dispatch.
+      if (!screen.queryByRole('menu')) fireEvent.click(openBtn)
+      const item = screen.getByRole('menuitem', { name: `Reasoning effort: ${cap(next)}` })
```

The `getByRole('menuitem', …)` form is strictly stronger than `getByTitle`: the trigger and the menu
item carry the **same `title` string** when the active value is `xhigh`, so any title-based query is
ambiguous on the active row (found the hard way, one call later).

## 3. Proof the patch is sufficient — applied to a sibling copy, never to the owner's file

```
$ cp Composer.test.tsx Composer.fixed.test.tsx      # + the 3 edits, via python, LF-normalised
$ npx vitest run app/components/chat/__tests__/Composer.fixed.test.tsx
 Test Files  1 passed (1)
      Tests  19 passed (19)

$ npx tsc --noEmit                                 # project-wide, with the patched copy in the tree
app/components/chat/__tests__/Composer.test.tsx(153,41): error TS2353: …   ← the ORIGINAL only
TSC_EXIT=2
```

So: with the 3 edits the file is **type-clean and 19/19 green**, and the copy was the only file
whose errors disappeared — the diagnosis is complete, there is no second cause hiding behind it.
The copy was removed afterwards; the tree is unchanged by this probe.

**Apply note:** the original file is **CRLF** (the patched copy was LF and both tools were happy).
Edit in place; don't pipe an LF diff into `patch` on it.
