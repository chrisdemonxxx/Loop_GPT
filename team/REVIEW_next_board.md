# REVIEW — next-board (P0 contract + A–R seats + M1 close)

Seat: `@code-review` (Static Review). Worktree verified at HEAD `770e228`
(`git rev-parse` → `770e228cdbe14a…`), two commits out
(`4e20ba8` staging trio + PHASES, `8bab825` research pin) on top of
`8e8f52f` (research's `DECOY_version_json`).

## Findings (must-fix / claim-level, all in the same diff)

**F1 — line 254 is 150 B of JSON *render*, not base64 of a 75 B body.**
`team/CORE_DEV_P2_EFFORT.md:254` is the literal object
`{"status":"completed","lang":"en-US","bankerOutreachText":"…2026. ..."}` —
151 B incl. LF, **0 CR** on the line (file is mixed-EOL). The `...` is
truncation *inside* `bankerOutreachText`, so 150 = the note's rendering
length, 2×75 as boss-bot said. Decoding the `990d8a1`-era note via
`base64 -d` is what made "150 vs 75" *look* like 2× before.
→ R2's "length-matched by an unrecorded render" is right; next sighting is a
**body sha256** per contract.

**F2 — `bankerOutreachText` appears in `DECOY_version_json.md` as *data*,
not prose.** The 6 hits were "prose or `_qa-m1`", but
`team/DECOY_version_json.md:31` is the field-name *note* and `:120` is the
same line 254 quoted as the witness row (prose).
`_qa-m1.mjs:47`'s sniff (`:47`, verified) only detects, never length-checks
— `:46`'s `bytes === 75 + 0` is the length leg, exactly why 150 looked
served. No decoy sha in tree — unchanged.

**F3 — 20/22 re-count matches; the 15th scratch `team/*.md` is the
`16bb161e` survivor, untracked, owner `@research-scout`.**
R3's bar ("`git clean -n` names zero `team/*.md`") and the
`4e20ba8` stage-trio are consistent; no new owner.

**F4 — `offense.py` + `tools/PATH.sh` are the 19 untracked scratch paths**
(arch's "19 paths = 5 `_final*` + 5 `tests/_*` + 2 + 2" = 14 named; the
other 5 include `offense.py`/`PATH.sh` at `c7263a00`/`5bf2430916699150`).
That's why boss-bot reproduced both hashes without the `team` files being
tracked — same §12.4 class, `@ops-release`'s one-hunk fix at `:391` closes
the empty-`tools/bin` shadow. Latent confirmed.

**F5 — the two `web/Dockerfile` hunks are the right shape (verified in-tree,
`:15` = ARG `GIT_REVISION`, `:31` = `node -e` writing
`out/version.json` as `{surface,revision:r||'unknown',builtAt}`).** Readback
`GET /version.json` for the pinned SHA is the acceptance term;
`8e2a79e` (10:55:46, `0 4` behind the branch) vs frozen
`builtAt 10:35:55` is §13.2 observed, not a bug —
`GIT_REVISION` is the only M1 term left, as `@boss-bot` says.

## Verdict

**ship.** Dispatch `eng-2026-09-28-001`, push the 5, land the two hunks +
`team/RELEASE_P1.md`.

## Raw

```
$ git rev-parse HEAD
770e228cdbe14a38957609bba4cf1bc554b38805
$ git show --stat --format='%h %s' 4e20ba8
4e20ba8 team: stage the 3 deliverable residue paths + PHASES 13.9/13.10
 team/NOTE_config_layer_hr-bot.md     | 133 +++
 team/OFFENSE_CONTRACT_ops-release.md|  66 +++
 team/P2_CLOSEOUT_boss-bot.md         | 121 +++
 team/PHASES.md                       |  29 +-
$ git status --porcelain | grep -c '^??'
20
$ sha256sum
f60f7993e83d21fba1611177670a44bc03c05e83861166a09e6ad965b372601c  DECOY_version_json.md
304cb87639db75b80b51a7d69d74c38933d562ddd37abf440ed9078ff5e93114  NOTE_config_layer_hr-bot.md
50a26f7aa78e02f1e827e2cf07dfd15479ad63922f08c4f302582b636d06b402  OFFENSE_CONTRACT_ops-release.md
173cdd7f96d767fe736a70654557fd8b2a04871be9295d95fc91ea145de0da8b  P2_CLOSEOUT_boss-bot.md
16bb161e0e629c0156988367e1f0c75c2af296cebfdffd7b2a2db6d1cbd7e3b0  RESEARCH_sandbox_tools_path.md
$ wc -c
10306  6332  3387  7194  3936   (DECOY / NOTE / CONTRACT / P2 / RESEARCH)
$ sed -n '254p' team/CORE_DEV_P2_EFFORT.md | wc -c   # 150 (+1 LF)
$ grep -c $'\r' → 0
$ grep -rn bankerOutreachText → 6  (:254 :266 :31 :120 :8 :907 + _qa-m1.mjs:47)
```
