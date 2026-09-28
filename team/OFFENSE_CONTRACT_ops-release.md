# OFFENSE CONTRACT — P0 frozen: `ENG-2026-09-28-001` (owner: `ops-release`)

to: room (`@boss-bot`, the 8 seats, `@user`)   from: `ops-release`   card: `t_2a55ad7e`   2026-09-28T12:4xZ
re: the P0 contract card — SOC placeholders filled, scope + RoE frozen, one commit. Raw evidence below.

## 1. Deliverable

`projects/development/ENG-2026-09-28-001/SOC/00..04` — the five contract documents, all 37 remaining
placeholders filled, **one** commit (`2897a3a`, branch `main`, 15 tracked files).

```
$ grep -o '<[^<>]*>' SOC/0*.md | wc -l
0
$ git -C <eng> log --oneline | wc -l
1
$ git -C <eng> log --oneline
2897a3a chore(eng): freeze SOC contract, scope and RoE (ENG-2026-09-28-001)
```

Frozen hashes (working tree == `HEAD`; read-back below):

```
d1ad18a1f9dc355837349385408f6f10f09148f06d238fc9055917da15b49dbf  SOC/00_Statement_of_Work.md
a7546a9db38b9cc3d99cc56ee135acc61966e35002215e33f7fc343278e8da43  SOC/01_Authorization_RWA.md
fa7e766e99391cb153a4b10aff3d4c1843353512ae8bf1feaf13aee4954e5244  SOC/02_Scope.md
2acb560d7c6366ae61424577a16506e12e5423392d33ed6876408fd97028662d  SOC/03_Rules_of_Engagement.md
365ae3f224244cf9dbdd3edccc1ef2bf65894cd725c44d65fa3e6a4ee0acf8a2  SOC/04_Evidence_and_Proof_Standard.md
```

## 2. Values written (all measured, none guessed)

| field | value | source |
|---|---|---|
| target apex | `loop-gpt.cyou` | card |
| first A-record | `69.46.46.61` | `nslookup loop-gpt.cyou` (resolver `10.64.0.1`) |
| resolver (pinned in RoE) | `10.64.0.1` | box resolver; the one `hr-bot`'s lane probes used (`TEAM_ROSTER_OFFENSE.md` §3) |
| vantage | `CJs` — Windows 11 (26200), MINGW64/MSYS2 | `uname -a`, `ipconfig` |
| operator principal | `chrisdemonxxx` | operator of record; same handle as `ENG-BLKST-2026-001` |
| authorizing party | `loop-gpt.cyou` owner-operator (`chrisdemonxxx`) | this engagement is on the operator's own platform |
| vault handle / account | `loopgpt-e2e` / `chrisdemonxxx+loopgpt-e2e@gmail.com` | `docs/ops-browser-agent-task.md` (target-side E2E account; handle only, no secret) |
| declared exclude | `evidence/raw/**` (scratch) | `evidence/README.md` rule |
| seed row | apex + `69.46.46.61`, `P0 kickoff` | the DNS probe above |

## 3. The LF correction (a real defect, found here)

The `init` step wrote the engagement copy of `SOC/*.md` **CRLF** (`CR=81/42/44/34/56` by byte count)
while the scaffold is LF-only, and `.gitattributes` is `* -text` — so git stores the working-tree bytes
verbatim and the CRLF would have shipped into the Phase-R manifest's tree. Normalized before the commit;
read-back from `HEAD`, not from the working tree:

```
$ python <tmp>/eng_head_check.py          # git show HEAD:<path> for every tracked file
HEAD read-back: 15 tracked files
CRLF blobs in HEAD: NONE (all LF)
angle-bracket tokens in HEAD:SOC/*: NONE
```

`tools/lf_normalize.py` (registered in `tools/README.md`) is the re-runnable check:
`python tools/lf_normalize.py <root> report` → lists every CRLF text file; `fix` rewrites it LF.

## 4. What this unblocks

The 8 seat cards are parent-gated on this one and are now dispatchable; the A→R chain starts at
`recon-passive` (phase A). `tools/VERSIONS.md` (the pinned binary manifest, the other `ops-release`
item on this box) is **not** touched here — `nmap` is still the one missing binary
(`team/OFFENSE_FRAMEWORK_boss-bot.md` §4.2) and stays a separate card.
