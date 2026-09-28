# P2 close-out — kanban board `offense` (owner: `boss-bot`)

from: `boss-bot`   2026-09-28   plan: `team/PHASES_PENTEST.md` §4 (P2)   roster: `team/TEAM_ROSTER_OFFENSE.md` §3
Verification rule applied: the DB was re-read after the writes; a create call's exit status is not evidence.

---

## 1. What changed (paths)

| path | change |
|---|---|
| `%LOCALAPPDATA%/hermes/kanban/boards/offense/kanban.db` | **new board `offense`** — 1 root card + the 8 seat cards A→R, chained parent→child, default workdir = the engagement tree |
| `profiles/<8 seats>/config.yaml` | `skills.external_dirs: C:/Users/chris/AppData/Local/hermes/skills/offensive` (the defect in §4; `hermes -p <seat> config set`, no hand-editing) |
| `profiles/boss-bot/config.yaml` | the same line — the defect was proven here first, on this profile |

No file inside the engagement tree (`projects/development/offense-fleet`) was touched by this pass.

## 2. Raw — the board

```
$ hermes kanban boards create offense --name "offense-fleet (A-R)" --default-workdir "C:/.../offense-fleet"
Board 'offense' created.
  DB path: C:\Users\chris\AppData\Local\hermes\kanban\boards\offense\kanban.db
EXIT=0

$ hermes kanban --board offense list
Board: offense (1 other board — `hermes kanban boards list`)

▶ t_a3272e9f  ready     ops-release           P1 - tool + skill layer: binaries on a durable path + pin tools/VERSIONS.md
◻ t_df609991  todo      recon-passive         A - recon-passive: OSINT / passive footprint
◻ t_eb2c410a  todo      recon-active          B/C - recon-active: active recon + network/service discovery
◻ t_f83c8195  todo      web-cartographer      D/E - web-cartographer: web surface + app mapping
◻ t_83749b4a  todo      input-fuzzer          F - input-fuzzer: input-validation vectors
◻ t_eb46d24d  todo      auth-session          G/H - auth-session: auth+session, authorization/IDM
◻ t_08b1b011  todo      api-dataflow          I/J/K - api-dataflow: API, TLS depth, config hygiene
◻ t_d0150e96  todo      exploit-op            L/M/N/O - exploit-op: exploitation -> escalation -> exfil -> persistence
◻ t_f557be32  todo      verifier              P/Q/R - verifier: coverage gaps, verification, killchain + manifest

$ hermes kanban --board offense stats
todo 8 · ready 1 · running 0 · done 0   (1 card per seat; root = ops-release)

# the chain, read back from each card's own JSON (parents/children, not the create exit code):
t_a3272e9f   ready    ops-release      parents=-            children=t_df609991
t_df609991   todo     recon-passive    parents=t_a3272e9f   children=t_eb2c410a
t_eb2c410a   todo     recon-active     parents=t_df609991   children=t_f83c8195
t_f83c8195   todo     web-cartographer parents=t_eb2c410a   children=t_83749b4a
t_83749b4a   todo     input-fuzzer     parents=t_f83c8195   children=t_eb46d24d
t_eb46d24d   todo     auth-session     parents=t_83749b4a   children=t_08b1b011
t_08b1b011   todo     api-dataflow     parents=t_eb46d24d   children=t_d0150e96
t_d0150e96   todo     exploit-op       parents=t_08b1b011   children=t_f557be32
t_f557be32   todo     verifier         parents=t_d0150e96   children=-
```

Every card carries: `workspace_kind=dir`, `workspace_path=C:/Users/chris/Desktop/Workspace/dev-projects/projects/development/offense-fleet`
(the shared engagement tree), its `--skill` set, its `--max-runtime 4h`, the verbatim P2 acceptance, its exact deliverable
paths and its kickoff note as the body. Checked on one card from each tier: `show t_df609991 --json`, `show t_f557be32 --json`.

## 3. Raw — the dispatcher actually routes (and runs)

```
$ hermes kanban --board offense dispatch --dry-run
Spawned: 1
  - t_a3272e9f  ->  ops-release  @ - (dry)

$ hermes kanban --board offense dispatch --max 1
Spawned: 1
  - t_a3272e9f  ->  ops-release  @ C:\Users\chris\Desktop\Workspace\dev-projects\projects\development\offense-fleet

$ hermes kanban --board offense list        # +25s
● t_a3272e9f  running   ops-release   ...
$ hermes kanban --board offense show t_a3272e9f --json
status running | started 1790594361 | runs 1 | events: created, claimed, spawned
```

The whole `offense` board is drained by the gateway's dispatcher (`hermes_cli/kanban_db_dispatch.py` iterates
`list_boards()`; `gateway/kanban_watchers.py` owns the dispatcher lock). One command per pass is
`hermes kanban --board offense dispatch`; the hands-off form is `hermes gateway run` / `install`.

## 4. Defect found in this pass — P1's "3/3 skills landed" was on-disk-only

The three P1 skills exist (`~/AppData/Local/hermes/skills/offensive/{evidence-harness,offensive-recon,delivery-gate-verification}/SKILL.md`),
and the loader walks that root (`iter_skill_index_files` returns all three), **but no profile resolved them**:

```
$ hermes -p recon-passive -s evidence-harness -z "..."
hermes -z: agent failed: Unknown skill(s): evidence-harness      <-- before
SKILL-OK                                                       <-- after the fix
```

Cause: a profile resolves skills from its own `skills/` dir plus `skills.external_dirs`; the shared root is not
in that set when a profile is active. Fix applied to the 8 seats + `boss-bot` (one line per profile):

```
$ hermes -p recon-passive config set skills.external_dirs "C:/Users/chris/AppData/Local/hermes/skills/offensive"
✓ Set skills.external_dirs = ... in C:\...\profiles\recon-passive\config.yaml
$ for s in <8 seats>; do hermes -p $s skills list | grep -cE "evidence-harness|offensive-recon|delivery-gate-veri"; done
recon-passive 3 · recon-active 3 · web-cartographer 3 · input-fuzzer 3 · auth-session 3 · api-dataflow 3 · exploit-op 3 · verifier 3
```

Without this, every `--skill` on the 8 cards would have died at spawn. `delivery-gate-verification` also exists as
`profiles/boss-bot/skills/devops/delivery-gate-verification` — two copies, same name; the roster's skill paths should
name one of them.

## 5. What remains (named, with owner)

1. **P1 binaries** — `ops-release`, card `t_a3272e9f`, **running now**: durable path + pinned `tools/VERSIONS.md`.
   Trap already on record: `nmap`'s self-installer wants admin, and this box has none.
2. **The engagement** — no `<ENG-ID>` dir and the five SOC docs in `offense-fleet/SOC/` are still the blank
   scaffold (67 `<...>` placeholders). The A card's body says to cut it from `offense-fleet/README.md` before its
   first `RAW` block; **name the target host and the ENG-ID** and the chain runs itself.
3. **The dispatcher loop** — `hermes gateway run` (foreground) or `install` (Scheduled Task). A one-shot
   `dispatch` pass advances exactly one card.
4. **P2 check 3** — the A→C dry run (`3 phase_*.md` + a resolvable registry row) needs 1 and 2.

## 6. Hand-off

- **`hr-bot`** → roster §3/§4: record the per-seat `skills.external_dirs` line (or copy the 3 skills into
  `profiles/<seat>/skills/offensive/`), and keep exactly one `delivery-gate-verification`. The board is cut and
  gated; nothing else in P2 is yours.
- **`user`** → the launch: `hermes gateway run` + the ENG-ID and the in-scope host. Cards, chain, models and
  skills are verified; the engagement is the last missing input.
