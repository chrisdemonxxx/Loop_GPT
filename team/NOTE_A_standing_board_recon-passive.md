# NOTE — phase A is landed on BOTH trees (standing board + engagement); read this before lane B/C

to: `recon-active` (standing-board card `t_eb2c410a`) · cc: `boss-bot` (plan/board), `ops-release` (P1)
from: `recon-passive`   2026-09-28T13:5xZ   engagement: `ENG-2026-09-28-001`   target: `loop-gpt.cyou`
proof: `offense-fleet/evidence/phase_A_osint.md` RAW-58..RAW-70 · registry `…-A-01`..`…-A-07`

## 1. Where lane A's artifact now lives (two copies, one run)

The A card was created twice — once on the standing board (`offense`, `t_df609991`, workspace
`…/projects/development/offense-fleet`) and once on the engagement board (`eng-2026-09-28-001`,
`t_d65fc1d0`, workspace `…/projects/development/ENG-2026-09-28-001`). The engagement card ran
first and committed there; the standing-board card has now landed the same deliverable in its own
workspace, because that is what its card body names.

| tree | commit | file | bytes | sha256 |
|---|---|---|---|---|
| `ENG-2026-09-28-001` (canonical engagement) | `b18a0d6` | `evidence/phase_A_osint.md` | 56,654 | `03e36677729d79f4f6a0033f90f28c69e5886ef9b1b85a611f400da0bbe640ff` |
| `offense-fleet` (standing board) | `b3056c7` | `evidence/phase_A_osint.md` | 65,030 | `3c95d20a20b19a2129afe7f80fe3cbeb35b0d136ebcd5b827e9c760e7629be0d` |

The standing-board copy is **not** a paraphrase: `RAW-1`..`RAW-57` are byte-identical to the
committed engagement file (the hash above is of the whole ENG file; the header of the standing
copy records it), and `RAW-58`..`RAW-70` are this seat's live re-probe run from the standing
board's own workspace at 13:43Z–13:47Z. Nothing in the footprint changed.

Both copies carry the same 7 registry rows (`ENG-2026-09-28-001-A-01`..`-A-07`); the standing
board's `findings/FINDINGS_REGISTRY.md` pointers were re-pointed at RAW-n that exist **in that
file** (verified: 7 rows, 0 unresolvable). `reports/evidence_manifest.sha256` sealed over 20
files, LF, root-relative, `check` → `OK 20 files covered, 0 mismatched, 0 uncovered, 0 absent`,
and `sha256sum -c` → 20/20 OK.

## 2. What B/C must plan against (unchanged from A, re-confirmed)

- apex `loop-gpt.cyou` → A `69.46.46.61` (RAW-10, RAW-59, RAW-64).
- the four service names are **one Railway project**: `api`→`69.46.46.80`, `app`→`69.46.46.50`,
  `chat`→`69.46.46.77`, `www`→`69.46.46.106`, each `CNAME *.up.railway.app`; the same
  `69.46.46.0/24` block, same `Server: railway-hikari`. Do **not** port-scan the third-party
  A-record for `api` (`172.67.222.170`, hackertarget) — A-05.
- `mail.loop-gpt.cyou` is name-only; MX is AWS SES inbound (`inbound-smtp.ap-northeast-1.amazonaws.com`),
  so the mail footprint is **out** of B/C's port scan.
- A re-probe from this workspace found **zero new assets** — the lane's stop condition holds after
  three consecutive passes.

## 3. Box state that moved since the A run (measured, not assumed)

- **Resolver still flaps.** Control read first (`nslookup example.com` → `one.one.one.one` /
  `2606:4700:4700::1111`, RAW-58). Then, inside a single pass: `dnsx` with the **defaults and
  no retry → 0 records** (`[WRN] 1 domains failed to resolve`, exit 0, RAW-61); the same command
  with `-retry 3` → the full set (RAW-62); `-r 1.1.1.1` → the full set (RAW-63); the box
  resolver → 4 of 6 (RAW-60). The SOC's `10.64.0.1` pin is still dead (A-06). Gate on **records**,
  re-run 2–3×, and pass `-r` with the value you just read.
- **The engagement's `tools/VERSIONS.md` has been rehydrated** (18 pin rows; `M` in the
  engagement tree at 13:47Z, RAW-70) — `ops-release` landed the fleet fix; the standing board's
  own copy is 135 lines with the same 18 rows (RAW-69). Row A-07 stays `Open` until the
  engagement's copy is committed.

## 4. Still open, not this lane's to close

- **A-04** (`Open`): no CAA RRset for the apex while CT shows three issuing CAs — Q re-probes.
- **A-07** (`Open`): the engagement's `tools/VERSIONS.md` is uncommitted there.
- `SOC/02`'s Scope Addition Log and the SOC resolver row (`10.64.0.1`) are the contract owner's;
  this lane writes only inside `evidence/ findings/ reports/ tools/`.
