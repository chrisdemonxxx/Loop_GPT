# RESEARCH — fresh-engagement launch cut: what the live probe confirms, and two traps it doesn't

to: room (`@boss-bot`, `@hr-bot`, `@user`)  from: `research-scout`  2026-09-28
scope: verify the 4-command cut that `boss-bot` posted, against the box, before the user pastes it.
method: live probes only (no docs). Raw command beside raw result. Board state restored after probing.

Board of record at probe time: `hermes kanban --board offense list` → `archived=1, running=1 (t_a3272e9f,
ops-release), todo=8`; 9 non-archived cards A→R, chain intact, ws `dir:.../offense-fleet`.

---

## CONFIRMED (each line = raw probe)

1. **`--default-workdir` is a real flag** — `hermes kanban boards create --help` lists
   `--default-workdir DEFAULT_WORKDIR  Default workspace path for tasks created on this board`. So the
   "pinned at create" premise holds. **Confidence: high.**
2. **The slug is immutable, the display name is not** — `boards --help`:
   `rename  Change a board's human-readable display name (slug is immutable)`. Use `rename <slug> <name>`
   (both positional; `--name` is **rejected**). **Confidence: high.**
3. **`--workspace dir:<path>` per card is real and the shape is right** — `hermes kanban create --help`:
   `--workspace WORKSPACE  scratch | worktree | worktree:<path> | dir:<path>  (default: scratch)`.
   Default really is scratch → boss-bot's trap (1) is correct. **Confidence: high.**
4. **`--skill` is repeatable and resolves in the worker** — `create --help`: `--skill SKILLS  Skill to
   force-load into the worker (repeatable)`. hr-bot's resolution work is the right layer. **Confidence: high.**
5. **"67 placeholders" is exact, not approximate** — measured on disk:
   `grep -oh '<[^>]*>' offense-fleet/SOC/*.md | wc -l` → **67**, distributed
   `00=18, 01=12, 02=19, 03=3, 04=15`. The scaffold commit message says `placeholders 67`; the tree
   matches it. **Confidence: high.**
6. **The scaffold is LF-only by construction** — `offense-fleet/.gitattributes` is `* -text`; tree is
   clean (`git status --short` empty). **Confidence: high.**
7. **`hermes gateway run` needs no `--force` on this box** — `hermes gateway status` → `Gateway is not
   running`; `hermes gateway list` → 20 profiles, **all** `not running`. `--force` is only required when
   a systemd/launchd/s6 service already supervises the profile (`gateway run --help`: "Without --force, the
   command refuses because a second dispatcher escapes the service and can corrupt shared gateway state").
   **Confidence: high.**
8. **The registry ships ZERO rows on purpose** — `findings/FINDINGS_REGISTRY.md` has a header row + an
   empty separator and the rest as prose; the file itself warns a copied engagement must not "inherit an
   `Open` it never earned". Do not "fix" the empty table. **Confidence: high.**

## NEW — traps the posted cut does not carry (both found by probe, not by reading)

9. **A colliding slug does NOT error — it silently renames the standing board.** Raw:
   ```
   $ hermes kanban boards create offense --name "dup probe"      # before: NAME = offense-fleet (A-R)
   Board 'offense' already exists.
     Display name: dup probe
     DB path:      C:\Users\chris\AppData\Local\hermes\kanban\boards\offense\kanban.db
   $ echo $?                                                   -> 0
   $ hermes kanban boards list                                 -> offense | dup probe | archived=1, running=1, todo=8
   ```
   `exit=0`, tasks untouched, but the display name of the **live** board was overwritten. A fresh cut that
   reuses a slug (or a second copy/paste of the `boards create` line) mutates the standing engagement
   instead of failing loudly. **Pick a slug that does not exist; verify with `boards list` first.**
   Restored by probe: `hermes kanban boards rename offense "offense-fleet (A-R)"` → `exit=0`, name back,
   `archived=1, running=1, todo=8` unchanged. **Confidence: high (raw above).**

10. **`cp -r offense-fleet "$E"` copies a live tree and its `.git`.** Two consequences, both measured:
    (a) `offense-fleet/` **is** the standing board's pinned workspace (`ws=dir:.../offense-fleet` on
    `t_a3272e9f`, and `t_df609991`) while `ops-release` is `running` — a `cp` taken now races P1, which
    will drop `tools/VERSIONS.md` + the binaries into `tools/`; the new engagement inherits a
    half-populated tree. (b) `.git/` is present in the scaffold dir, so the copy inherits the scaffold
    repo (11 tracked files: `.gitattributes`, `README.md`, `SOC/00..04`, `evidence|findings|reports|tools/README.md`).
    Cleaner and race-free: export only what is committed, then re-init —
    `mkdir -p "$E" && git -C offense-fleet archive HEAD | tar -x -C "$E" && git -C "$E" init -q`.
    **Confidence: high for the facts; the "cleaner" line is my recommendation, labelled as such.**

## UNVERIFIED

- `hermes gateway run` "iterates ALL boards" — the claim is plausible and consistent with `boards --help`
  ("Each board has its own DB, workspaces directory, and dispatcher loop") but I did **not** run the
  gateway to watch it dispatch. **UNVERIFIED — do not assert it in the user-facing answer.**
- The dispatcher card→profile spawn ordering on a *new* board: only probeable after a new board exists.

## Net effect on the user's answer

boss-bot's cut is accurate on flags, per-card `--workspace`, the 67 count and the skill trap. Add two
lines before running it: **(i) confirm the chosen slug is not in `boards list` (a collision silently
renames, exit 0); (ii) scaffold with `git archive HEAD`, not `cp -r`, because the dir you would copy is
the running board's own workspace.**
