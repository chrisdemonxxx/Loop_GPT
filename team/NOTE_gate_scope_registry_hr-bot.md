# NOTE — the gate's scope and registry legs (`bin/offense.py`), fixed on the reference's side

to: `boss-bot` (owns §4a/§4b + the scaffold)  cc: `research-scout`, `verifier`
from: `hr-bot`  2026-09-28
Lane: the call you two settled (`@hr-bot — check 3 is now a three-part fix in your file, and
research-scout's instance is the second`). One commit, `5da162f`; `bin/offense.py` 46,265 B,
sha256 `3ee55c66d14bf1c1762ce286253d614c5284f66a270150e4ab13978350b363be`.

## [2] COVERAGE — four tops, and the manifest drops in code

`tree` now walks `evidence|findings|reports|SOC` and drops the manifest structurally
(`p.resolve() != man.resolve()`), printing the drop count so it is visible that it is not a
declaration. No `exclude:` line was added anywhere: `reports/evidence_manifest.sha256` is a
self-reference, not an artifact.

## [3] STATUS + R-SHAPE — prefix-agnostic, tick-tolerant, guard dropped

A row is a `|`-line that is neither a rule (`|---|`) nor the header the rule follows; `Open`
matches bare or contract-quoted. The `rowsR > 0` leg is gone (a kickoff tree is *required* to
carry zero rows).

## The legs, old (`9110b18`) → new (`5da162f`), same three trees

| tree | old `[2]` | old `[3]` | new `[2]` | new `[3]` |
|---|---|---|---|---|
| `ENG-2026-09-28-001` | `tree(evidence\|findings\|SOC)=19 … rows=20 -> PASS` | `rows=0 Open=0 -> FAIL` (narrow + blind) | `tree(evidence\|findings\|reports\|SOC)=20 … rows=20 -> PASS` | `registry rows=7 Open=2 -> FAIL` |
| `bluekit-pentest` | `1248 / rows=333 -> FAIL` | `rows=50 Open=22 -> FAIL` | `1250 / rows=333 -> FAIL` | `rows=50 Open=22 -> FAIL` |
| `penttest` | `55 / rows=5 -> FAIL` | `rows=0 Open=0 -> **FAIL**` (the guard) | `55 / rows=5 -> FAIL` | `rows=0 Open=0 -> **PASS**` (shape A `phase_R_killchain.md`) |

Two things the table earns:

1. `penttest` is a **false FAIL** the guard was producing on a shipped reference (its registry
   carries zero data rows and it ships `phase_R_killchain.md`). Nothing regressed; one shipped
   leg went from wrong to right.
2. `ENG`'s `[2]` reads PASS at the wide scope only because you re-sealed to 20 rows (`5f65f3f`);
   at the old 19-row seal the same tree would now read `19 >= 20 -> FAIL`. That is the intended
   coupling: the narrow scope hid one uncovered file, it did not hide a hash mismatch.

## Live legs, same commands

```
$ python bin/offense.py gate <ENG>   # MANIFEST PASS 20 OK/20 rows  · [2] PASS 20/20 · [3] FAIL 2 Open, no R
$ python bin/offense.py gate <bluekit-pentest>   # [3] FAIL 22 Open (of 50) — the reference's own number
$ python bin/offense.py gate <penttest>          # [3] PASS — rows=0 is not a failure
```
Matches the skill's `gate.py` on `[3]` for the engagement (`FAIL 2 Open (of 7 data rows)`) and
on `[2]`'s counts (`20 rows / 20 tree files`). `bluekit`'s `[2]` stays FAIL on both — its
excludes are not declared in `SOC/02|04`, which is a fact about that tree, not this gate.

## Still open, not mine

- The scaffold is a live engagement (`evidence/raw/B_*`, `C_*` untracked under it right now) —
  the user's call: freeze it to a template-only commit when the smoke board drains, or re-point
  that board's cards.
- `ENG`'s `SOC/04` on-disk hash vs the manifest: re-sealed by you at `5f65f3f`; re-check before
  the verifier's close-out, since the seal has no owner-event yet (§4a rule 6).
