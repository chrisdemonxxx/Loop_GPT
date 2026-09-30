# VISUAL_PARITY.md — the pixel ledger (seat `pixel-measure`, ledger **P6** / blueprint **P1**)

Measured on HEAD `48e613dcb3bcb66f5fbdd41c7f58947d263fc63a` — `git rev-parse HEAD` = `48e613dcb3bcb66f5fbdd41c7f58947d263fc63a` (branch `release/owned-staging-20260917`).
This is the ledger AND the gate: a screen is DONE only when a row here carries the command,
the byte counts + sha256, the measured delta, and the verdict — `<= 0.5%` at every reference viewport.

## Raw command (freeze) — baselines + manifest

```
cd frontend && npm run build          # real static export -> frontend/out/  (never a mockup)
node tests/serve-out.cjs &            # stubbed API on http://127.0.0.1:4123
node tests/visual/measure.cjs        # writes tests/baselines/** + MANIFEST.json
```

Raw result: exit `0`.
- `frontend/tests/baselines/MANIFEST.json` — `headRevision 48e613dcb3bcb66f5fbdd41c7f58947d263fc63a`, `capturedAt 2026-09-30T02:15:48.887Z`,
  `command "node tests/visual/measure.cjs"`, `30` entries (screen x theme x viewport).
- 30 PNG baselines + 30 a11y snapshots written, `deviceScaleFactor: 2`, fonts loaded,
  `reducedMotion: reduce`, `document.getAnimations()` paused at capture.

## Raw command (delta) — re-render HEAD, diff vs the frozen baselines

```
node tests/visual/measure.cjs --verify   # writes tests/baselines/deltas.json
```

Raw result: exit `0` · `rows 30` · worst delta `0.0000%` · `FAIL 0`.
Every row: `deltaRatio 0.0000` (`diffPixels 0`) and `a11yDiff 0` — the render is byte-identical
to the frozen baseline, and the role/name a11y tree is identical. The frozen baseline is
`48e613dcb3bcb66f5fbdd41c7f58947d263fc63a` == HEAD, so this delta is the freeze/determinism check, not a frontier delta
(no frontier reference capture is in scope yet — see *Not-yet-measured*).

## Baselines — byte size + sha256 (of the frozen PNG on disk)

```
find frontend/tests/baselines -name '*.png' | sort | xargs sha256sum
```

| # | screen | theme | viewport | PNG bytes | sha256 | delta % | a11y sha256 | verdict |
|---|--------|-------|----------|-----------|--------|---------|--------------|---------|
| 1 | landing | dark | 1440x900 | 401999 | `92439c18eb0658a3dd55c2fd32550f5c2040b60fec55eef39a24010a7b0ea50c` | 0.0000% | `65537085c0ea80a34faf6bec7dd4074fa5a83fecf939c646df3ea3b2adcb2519` | PASS |
| 2 | landing | dark | 1280x800 | 357234 | `99d61c5da5ddd2dcfffec0124d9b9311b976834735a9b617fd8822815a9a17f8` | 0.0000% | `65537085c0ea80a34faf6bec7dd4074fa5a83fecf939c646df3ea3b2adcb2519` | PASS |
| 3 | landing | dark | 820x1180 | 403709 | `54f4a45b0f38cff803af934745ba02d08663980afe312c7d4ecb7c20bf9d770f` | 0.0000% | `65537085c0ea80a34faf6bec7dd4074fa5a83fecf939c646df3ea3b2adcb2519` | PASS |
| 4 | landing | dark | 390x844 | 245988 | `cedb859b61a4630cddc2fc5d2067aaaaf622a54ab2d2a14f0cee86e531d3a7fb` | 0.0000% | `76879555f910db3108865c6d89aa32f14592bd2873a272c46ab3839e354c983b` | PASS |
| 5 | landing | dark | 320x844 | 197116 | `c5564315362818366c264078bca4bf7f612eaf661e90c4bfb0ad618915a4f20b` | 0.0000% | `76879555f910db3108865c6d89aa32f14592bd2873a272c46ab3839e354c983b` | PASS |
| 6 | landing | light | 1440x900 | 228292 | `91d70d012ca3ad531ff9ba5ca497151bca7014edf99738df27f5f358dca68969` | 0.0000% | `65537085c0ea80a34faf6bec7dd4074fa5a83fecf939c646df3ea3b2adcb2519` | PASS |
| 7 | landing | light | 1280x800 | 181609 | `19cbeb0d3584dfc52706aecfb5e727fe05cf388f1d278e4378eb8055f4b2da4f` | 0.0000% | `65537085c0ea80a34faf6bec7dd4074fa5a83fecf939c646df3ea3b2adcb2519` | PASS |
| 8 | landing | light | 820x1180 | 262427 | `61706ed7a9daf5954612abf753123c627e93a0508fdd247d3c8c100e47a0f3c3` | 0.0000% | `65537085c0ea80a34faf6bec7dd4074fa5a83fecf939c646df3ea3b2adcb2519` | PASS |
| 9 | landing | light | 390x844 | 138166 | `22ba65f7e3313cd374161b8a6302c80eeaa39d67168084bf3360e540e226f176` | 0.0000% | `76879555f910db3108865c6d89aa32f14592bd2873a272c46ab3839e354c983b` | PASS |
| 10 | landing | light | 320x844 | 114112 | `6f72edf7e33feb51091a6a820f9a753b7f8c66b63eec3cf4b8f648ac3ed3b3fe` | 0.0000% | `76879555f910db3108865c6d89aa32f14592bd2873a272c46ab3839e354c983b` | PASS |
| 11 | chat-shell | dark | 1440x900 | 163166 | `b3d4413cf26f39d65177e77d012e6fccab5636e13b5572961d1dad2b324c42f3` | 0.0000% | `7dd8d1451c7f39a84c6f3bde8b9b2fde757970f59cb716e96f4c22d8c2142ad1` | PASS |
| 12 | chat-shell | dark | 1280x800 | 158986 | `7deec14313bea68d5c3f57e856ed404a92ef2876a9af5a17b628e5d31cfab8ea` | 0.0000% | `7dd8d1451c7f39a84c6f3bde8b9b2fde757970f59cb716e96f4c22d8c2142ad1` | PASS |
| 13 | chat-shell | dark | 820x1180 | 155844 | `cec24ca0356a4ed9e1dedfa31b04d5b11dd566bde6c21013e57664c6bd03ecb5` | 0.0000% | `7dd8d1451c7f39a84c6f3bde8b9b2fde757970f59cb716e96f4c22d8c2142ad1` | PASS |
| 14 | chat-shell | dark | 390x844 | 110902 | `85de422a1745a69d0ac7a41fd5a48ee3299a4be35512bb1a9914a3bcfefaaf70` | 0.0000% | `4ece1d15a7d07103aadc2307708b84744143bf7ec936a336ce62bad55b8634c0` | pending P5 |
| 15 | chat-shell | dark | 320x844 | 111882 | `3437787eefb82ebd667d81250b7084803c17b459bc74ed134fd0c78b442de655` | 0.0000% | `4ece1d15a7d07103aadc2307708b84744143bf7ec936a336ce62bad55b8634c0` | pending P5 |
| 16 | chat-shell | light | 1440x900 | 153946 | `33fa45d552139cec1bf82847adc24fefc9431dff714531da6585627ce21000ca` | 0.0000% | `2d904643c40476016bb536077ddca5a83be57ad8fb63ce11e83bfc6d253e95bf` | PASS |
| 17 | chat-shell | light | 1280x800 | 148436 | `fcc822e4c7c9809b408fd96643d68208430183572d7034cb4982f33d3d513731` | 0.0000% | `2d904643c40476016bb536077ddca5a83be57ad8fb63ce11e83bfc6d253e95bf` | PASS |
| 18 | chat-shell | light | 820x1180 | 146338 | `65de3215783e5cd9380c98a1c66e218bede3a0dc198d34dd2fbcb727631d8ed1` | 0.0000% | `2d904643c40476016bb536077ddca5a83be57ad8fb63ce11e83bfc6d253e95bf` | PASS |
| 19 | chat-shell | light | 390x844 | 105980 | `2aa6c9757891f4ccd1d25ed1eedcc1c02d16c43bf4cb131d6af619dffb6df209` | 0.0000% | `4d46de0fc9dcb18ec09f9730d72fec01e7e1cc095da952186cb7332f7475208e` | pending P5 |
| 20 | chat-shell | light | 320x844 | 106142 | `6fab12ebe92d769b7bc33858121732c81fffdb1ebdd963c1f9cf1758faaba405` | 0.0000% | `4d46de0fc9dcb18ec09f9730d72fec01e7e1cc095da952186cb7332f7475208e` | pending P5 |
| 21 | settings | dark | 1440x900 | 212450 | `754d8c10d3c4f8a48035ae59ed52a077610ff306577a29895d38479c0268abd3` | 0.0000% | `39c58da741c6b789ff2755206a3c6f2b5a1341fb66679fbba6efbf89c5751cd2` | PASS |
| 22 | settings | dark | 1280x800 | 203895 | `dbba79a0bc94d188d1f724667942446b01e9db7f537ceb484f0640a605973d76` | 0.0000% | `39c58da741c6b789ff2755206a3c6f2b5a1341fb66679fbba6efbf89c5751cd2` | PASS |
| 23 | settings | dark | 820x1180 | 198983 | `4076e09367911f5f81a1e8ec85461deaaf820ff3b3bc1afd56760199e019cb7c` | 0.0000% | `39c58da741c6b789ff2755206a3c6f2b5a1341fb66679fbba6efbf89c5751cd2` | PASS |
| 24 | settings | dark | 390x844 | 129027 | `df1bca489eb8d2c7ce066f41e2da64a31a91fdc42f5eeee9be23c8fb1323033e` | 0.0000% | `39c58da741c6b789ff2755206a3c6f2b5a1341fb66679fbba6efbf89c5751cd2` | PASS |
| 25 | settings | dark | 320x844 | 125770 | `fefb5915973dc2cf65f6454825db42f7e6c41a28d1c588ea7b36c5395c98ba92` | 0.0000% | `39c58da741c6b789ff2755206a3c6f2b5a1341fb66679fbba6efbf89c5751cd2` | PASS |
| 26 | settings | light | 1440x900 | 217948 | `a26c224c304e936ccee5cc971d9f812340fb21d4161918611fcde7c46b033fb8` | 0.0000% | `28ac4b4403857c09410c01427306177bbad2bee7cf66c2406faa6dd55717e9b2` | PASS |
| 27 | settings | light | 1280x800 | 209310 | `05698c868b8ae425533356acdcea6c18dc6c044d6359f94080fd52501edd8e7b` | 0.0000% | `28ac4b4403857c09410c01427306177bbad2bee7cf66c2406faa6dd55717e9b2` | PASS |
| 28 | settings | light | 820x1180 | 204615 | `ed640be560dcf210a2ef2d50ed5f98a8960df7c22593167f8eac17f1dc4b9e9b` | 0.0000% | `28ac4b4403857c09410c01427306177bbad2bee7cf66c2406faa6dd55717e9b2` | PASS |
| 29 | settings | light | 390x844 | 134685 | `627c1febd5b6b17da23adce5ed84ed2a7f3b78db09d4bf2d9e3ee844f6117d95` | 0.0000% | `28ac4b4403857c09410c01427306177bbad2bee7cf66c2406faa6dd55717e9b2` | PASS |
| 30 | settings | light | 320x844 | 130674 | `d87ad1818da36492fc1bf96912531ccbd837609b93f22df9af684a84ad8af93a` | 0.0000% | `28ac4b4403857c09410c01427306177bbad2bee7cf66c2406faa6dd55717e9b2` | PASS |

**Baseline total: 30 PNG, 5659631 B; a11y 30 json. MANIFEST sha256 = `059194bb3f5e47134c28ea718739640620880e7c699843538d409c0b37844786`.**

## Screens — what exists today vs in flight

| screen | route (static stub) | a11y-tree snapshot | status |
|--------|--------------------|--------------------|--------|
| landing | `/` | present, diff 0 | **measured, PASS** |
| chat-shell | `/chat/` (stands in for `/chat/:uuid`; the stub carries no conversation rows, so the empty shell is the only render) | present, diff 0 | **measured, PASS** @1440/1280/820; **pending P5** @390/320 |
| settings | `/chat/` -> sidebar -> Settings dialog (`[role=dialog][aria-label="Agent settings"]`) | present, diff 0 | **measured, PASS** |

### In-flight (NOT a delta against this seat)
- **composer** is not a separate screen — it is the composer region inside `chat-shell`.
  The P5 defect (Send button `424..460` = 70px past a 390px viewport, `Composer.tsx` `49f40669`)
  has NOT landed, so the `chat-shell` rows at **390x844** and **320x844** carry that defect and
  are marked `pending P5`. Re-measure on the frozen revision before P10's lock.
- Delta rows are filed to **`ui-visual`** largest-region-first; this seat does not edit
  `frontend/app/**`. No component delta is filed today: the re-render is byte-identical.

## Not-yet-measured (explicit, not hidden)
- Frontier pixel-delta (clone vs Claude/ChatGPT/Grok) — no frontier reference capture exists yet;
  today's `deltaRatio` is baseline-vs-live replay determinism. First `delta != 0` row appears
  when a component fix lands and the baseline is deliberately NOT re-frozen.
- The 9 missing §4 route trees are not waited on (`measure.cjs` SCREENS docstring).
- `frontend/tests/e2e/visual-parity.spec.ts` (Playwright `toHaveScreenshot` + a11y parity) is the
  next artifact for this seat; `frontend/tests/e2e/app.spec.ts` stays `qa-verify`'s.

_generated from MANIFEST.json + deltas.json at 2026-09-30T02:19:53.485372Z — no number transcribed by hand._
