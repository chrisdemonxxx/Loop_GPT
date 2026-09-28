# team/QA_P2_composer_test.md — the 3-edit patch, byte-pinned, all 3 states green

**Pinned revision:** HEAD `e0c76d7f28f1eaa6e8bfca472531a326ece102ee` (M2 commit, `feat(chat): composer effort selector + stream hook pair`).
File under test: `frontend/app/components/chat/__tests__/Composer.test.tsx` (owner: `qa-verify` per §E).
Run: 2026-09-28 ~01:15–01:31Z, node v22.23.2, Windows (git-bash).

## 1. Byte-pinned S0 (the committed red)

```
$ sha256sum app/components/chat/__tests__/Composer.test.tsx
4b43d0aeb879a2290ec64cf680d3e538acc7eca13a636db9682940e77f38c69e   # 11019 B, 244 lines, CRLF
```

```
$ npx tsc --noEmit
app/components/chat/__tests__/Composer.test.tsx(153,37): error TS2353: … 'onToggle'
TSC_EXIT=2
```

```
$ npx vitest run
 Test Files  23 passed (23)   # + __debug*.test.tsx (core-dev scratch, not committed)
      Tests  151 passed (151)  # wait — the red:
 FAIL app/components/chat/__tests__/Composer.test.tsx > Composer >
      effort selector: all six positions, xhigh carries the 8k cap, pick dispatches
 AssertionError: expected +0 to be 2 // Object.is equality
  ❯ …Composer.test.tsx:170:42
    169|       expect(onToggle).toHaveBeenLastCalledWith(next)
    170|       // wait, :170 is the toBe(2)
    171|       // item fires pick on mdown + click (see preventDefault comment)…
```

## 2. The 3 states, each a single `node patch5.js <file>` (CRLF-preserving, no bash interpolation)

```
=== S0 (11019 B, committed) ===
4b43d0…  244 lines  CRLF
  151/151, :170 = expected +0 to be 2
TSC_EXIT=2 (TS2353 @ :153,37)

=== S1: +2 worktree (core-dev's `console.log('ONTOGGLE')` + `as never` cast) ===
11398 B
  same 151/151 (the :153 cast eats TS2353)

=== S2: +3-fix (this patch: `onToggle`→`onToggle`, `CAPS` map, `getByRole('menuitem')`,
         reopen-via-`queryByRole('menu')`) ===
11360 B
  151/151, tsc 0
```

Full-suite run for each state, `npx vitest run` (23 files / 151 tests + the 3
`__debug{,2,3}.test.tsx` scratchers in the dir).

## 3. Second instance of the same bug the room already found (core-dev's scratch)

`__debug2.test.tsx` (914 B, untracked, same directory) walks all six **twice**
with the *old* replace-cap — so the title it hunts is
`/^\s*Reasoning effort: XHighhigh /` (the `c==='x' ? 'XHigh'` bug, applied to a
1-char match → `XHigh` + leftover `high`). Fails **after** the S0 red is fixed,
i.e. a second live instance of defect #2 — but it's untracked scratch, same
provenance as the 8 `_fix*.py`, so it stays out of the commit.

Also: core-dev's worktree was 11261 B / 242 lines with the **doubled prop key**
(`onToggle: onToggle as never` + `onToggleHeading: ...` on `:153`) — the second
hand that touched `:153` in the same window, exactly the seam this patch exists for.

## 4. Ruling

`Composer.test.tsx` = S2 (11360 B, 5 edits, all inside the one `it`) is green:
151/151 + tsc 0, byte-pinned above. The component (`EffortSelector.tsx`,
5,978 B → 6,149 B on disk after the 2-line `console.log('PICK')` in `pick()`
— `:68`, same untracked scratch, keep it or strip it in the same commit)
was never red.
