# NOTE — the three cold-path defects: fixed, with a cold tree re-run as the evidence

to: room (`@research-scout`, `@hr-bot`, `@user`)   cc: `verifier`, `ops-release`
from: `boss-bot` (owns the ledger + the scaffold's seal)  2026-09-28T15:0xZ
Lane: static review. All three defects were reproduced cold before a byte was changed.

---

## 1. What shipped

| repo | commit | what |
|---|---|---|
| `offense-fleet` | `60a6472` | zero-row registry, the standing run's evidence untracked, the scaffold's stale `SOC/04` row re-sealed |
| `offense-fleet` | `daafa26` | template/ledger split + `init` writes the ledger and seals its own manifest + `_table_rows` |
| `ENG-2026-09-28-001` | `2ecadc1` | the A-04/A-07 rows (the room's ask) |
| `ENG-2026-09-28-001` | `03768a5` | the tree's own pin header, 18 → 16 |
| `loop-gpt/team` | `4408db1`, this file | the ledger record |

`bin/offense.py` at `daafa26`: 51,185 B, sha256 `3996b4fbcb90c4c086684093…` (`ast.parse` OK).
`@hr-bot` — it is your file (last touch `5da162f`, 45 min quiet); if you have an edit in flight,
say so and I will rebase onto it.

## 2. Defect 1 — a fresh `init` inherited the standing board's ledger (confirmed, then killed)

```
$ git archive HEAD | tar -t | grep -E '^(evidence|findings)/'      # before
evidence/README.md
evidence/phase_A_osint.md
evidence/raw/A_apex.html … (11 files)
findings/FINDINGS_REGISTRY.md          # 2,623 B, 7 rows named ENG-2026-09-28-001, 2 Open,
                                       # A-04 in its pre-2ecadc1 wording
```
```
$ git archive HEAD | tar -t | grep -E '^(evidence|findings)/'      # after (daafa26)
evidence/README.md
findings/FINDINGS_REGISTRY.template.md
```

Root cause is structural, not a stale file: **one directory is both the scaffold (`git archive HEAD`)
and the standing board's pinned workspace**, so any tracked artifact is a leak. So the registry is now
split — `findings/FINDINGS_REGISTRY.template.md` (tracked, zero data rows) and
`findings/FINDINGS_REGISTRY.md` (the standing run's, untracked + ignored) — and `init` calls
`reset_ledger(E)`: writes the live registry from the template and unlinks any `evidence/phase_*.md`
and `evidence/raw/*` that ride along. The standing run's 7 rows were restored to its own file from
`60a6472^` (2,623 B, 7 rows — it lost nothing).

## 3. Defect 2 — the count that never touched the thing it counted (confirmed, fixed at the source)

`_pin_rows` and `materialise_pins` counted any `lstrip().startswith("|")`: the header row and the
`|---|` rule are two of the 18, so 16 binaries read as 18, and the number was *written into* every
engagement's committed header and printed by `init`/`doctor`. Both now use `_table_rows()`, the same
predicate the gate's `[3]` has had all along (`bin/offense.py:834`).

```
$ offense tools ENG-2026-09-28-001 --repin
  VERSIONS.md re-pinned (16 row(s)) <- …/offense-fleet/tools/VERSIONS.md
$ head -4 ENG-…/tools/VERSIONS.md | tail -1
# rows below are that file's, verbatim — 16 binary row(s).
$ diff offense-fleet/tools/VERSIONS.md ENG-…/tools/VERSIONS.md
0a1,4                                    # the provenance header, and nothing else
```

## 4. Defect 3 — the scaffold's own seal (confirmed, re-sealed)

`SOC/04` on disk `f4e12317…` vs its manifest row `e95648a8…` → `gate .` read
`rows=24 OK=23 FAILED=1`. Re-sealed. But the deeper fix is §5: the archive's manifest describes the
*scaffold's* tree, and a sandbox's `SOC/` is placeholder-filled and its registry is new, so **every**
inherited row is wrong on arrival — `init` now seals the tree it actually made.

## 5. The acceptance test — a real cold tree, gate run on it

```
$ python -c "import offense; offense.provision(offense.load(), 'ENG-SMOKE-20260928-999', {'target':'smoke.test'})"
files from archive: 28
pins              kept 16 row(s)
sealed rows       9          # this tree's, not the scaffold's
registry rows     0          # the template
inherited phase files removed: 0   []      # nothing left to remove — the archive is clean

$ bash bin/offense gate ../ENG-SMOKE-20260928-999
1) MANIFEST   rows=9 OK=9 FAILED=0 unreadable=0 malformed=0  -> PASS
2) COVERAGE   tree(evidence|findings|reports|SOC)=9 counted=9 manifest rows=9  -> PASS
3) STATUS+R   registry rows=0  Open=0   R shape A none / shape B 0 files  -> FAIL
--- gate: MANIFEST=PASS COVERAGE=PASS STATUS+R=FAIL ---
```

Before: `registry rows=7 Open=2 -> FAIL` on a tree nobody had worked in, and `[1]`/`[2]` red on the
inherited manifest. Now the only red is the R-shape leg, which is a **close-out** check by
construction — R's file arrives with the verifier. (Cold tree removed after the run.)

## 6. What remains

- `ENG-2026-09-28-001`: gate `MANIFEST=PASS 20/20 · COVERAGE=PASS 20/20 · STATUS+R=FAIL` — 2 `Open`
  (A-04, A-07), no R. The verifier's Q clears them; R emits the killchain + the final manifest.
- The standing board's live tree: `registry rows=0` on the scaffold now (its rows live in the
  untracked live ledger) — its verifier should read `findings/FINDINGS_REGISTRY.md`, not the template.
- `ops-release`: the resolve assertion in `shim_selftest` (`team/NOTE_path_shim_element_form_ops-release.md`).
  Note the shim the seat sources is the **generated** one (`bin/offense.py:shim_text`, 410 B here),
  whose element 2 is the standing repo's absolute path — the selftest already asserts on the right
  file, it just never resolves a binary through it.
- `@user`: a fresh host is now a **new ENG-ID + `--target`** with a clean tree (the template fix
  landed); name the host and the board gets cut.
