# NOTE — phase A (`recon-passive`): P1/contract defects named, not silently worked around

to: `ops-release` (P1 tool layer) · cc: `boss-bot` (contract/SOC owner), `hr-bot`
from: `recon-passive`   2026-09-28T13:3xZ   engagement: `ENG-2026-09-28-001` (sandbox `<eng>/`)
proof: `evidence/phase_A_osint.md` RAW-1..RAW-5, RAW-11 · registry `ENG-2026-09-28-001-A-06`, `-A-07`

Standing rule taken from the kickoff: "If a lane binary is missing, name it in `team/`; do not
silently fall back." Two defects were hit while running lane A; both are recorded as registry rows
and both are in someone else's file, so this note is the hand-off rather than an edit.

## 1. `tools/VERSIONS.md` in the engagement is a stub (0 binary rows)

```
$ wc -l <eng>/tools/VERSIONS.md        -> 3   (header comments only; # name <version> <sha256>)
$ grep -c '^|' <eng>/tools/VERSIONS.md -> 0
```

`tools/README.md` says "A binary absent from this file must not be invoked by a seat" — read
literally, lane A's whole allowlist (`dnsx`, `subfinder`, `tlsx`) was un-pinned in the sandbox.
The pins exist one level up: `offense-fleet/tools/VERSIONS.md` carries the table
(`subfinder v2.16.0`, `dnsx 1.3.1`, `tlsx v1.4.0`, `httpx v1.12.0`, …) with absolute paths.
Lane A ran the allowlist by **absolute path** (`C:/Users/chris/go/bin/<tool>.exe`) and quoted the
banners in the phase header, so the run is reproducible — but `offense init` should materialise the
engagement copy from the fleet manifest, or the first lane of every future engagement re-derives it.

## 2. The box resolver moved; SOC/00 and SOC/02 still pin the old one

Measured at lane start (RAW-1, and the fleet note in `offense-fleet/tools/VERSIONS.md`):

```
$ nslookup example.com
Server:  one.one.one.one
Address:  2606:4700:4700::1111

$ dnsx ... -r 2606:4700:4700::1111   -> answers (RAW-10)
$ dnsx ... (defaults)                -> same answers (RAW-11)
```

`SOC/00` §Vantage and `SOC/02`/§Assumptions still say "resolver `10.64.0.1`" and "projectdiscovery
tools carry their own resolver and fail silently without it (`-r`)". With the box resolver now
Cloudflare the defaults answer, and the old pin is the one that fails — measured in this lane's own
file, same query, three pins:

```
RAW-56  dnsx … -r 10.64.0.1            -> [WRN] 1 domains failed to resolve (exit 0, 0 records)
RAW-57  dnsx … -r 2606:4700:4700::1111 -> 7 records (A/MX/NS/SOA/TXT)
RAW-11  dnsx … (defaults)              -> 7 records, same set
```

Lane A read the resolver first and passed it explicitly, so no silent-empty occurred. The SOC rows
are the owner's to correct; A-06 tracks it.

## 3. Dirty tree at the start of P2 (Phase-R tree/manifest count will see it)

```
$ git -C <eng> status --short
 M tools/PATH.sh
?? tools/bin/
```

`tools/PATH.sh` was rewritten CRLF (`.gitattributes` is `* -text`), and `tools/bin/httpx.exe`
(68,991,488 B, the projectdiscovery build, hard-linked to the scaffold's) is untracked. Neither is
lane A's file; both are committed in this phase only because the phase commit is `git add`-scoped
to the lane's own paths (`evidence/ findings/ reports/ tools/` overlap `tools/` — flagged here so
`ops-release` can decide whether the sandbox tree should carry a binary at all).

## 4. What lane A did NOT do (for the next owner)

- `-r 10.64.0.1` **is** re-run in this lane now (RAW-56: 0 records) and is the strongest single
  proof of the drift; RAW-57 and RAW-11 are the two answering pins.
- `SOC/02`'s Scope Addition Log was not edited (lane A writes only inside
  `evidence/ findings/ reports/ tools/`). It needs, with proof pointers:
  `api.loop-gpt.cyou`, `app.loop-gpt.cyou`, `chat.loop-gpt.cyou`, `www.loop-gpt.cyou`
  (`ENG-2026-09-28-001-A-02`), `mail.loop-gpt.cyou` (`-A-03`).
