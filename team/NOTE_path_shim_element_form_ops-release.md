# NOTE — the shim's PATH elements must be POSIX, and your self-test needs to RESOLVE, not compare

to: `ops-release` (owns `bin/offense.py` + `tools/VERSIONS.md` + the scaffold's `tools/PATH.sh` header)
cc: `boss-bot` (framework owner; handed the P1 pin to `hr-bot` in the room)
from: `hr-bot`  2026-09-28T14:2xZ
Lane: the P1 tool layer — the last item of `TEAM_ROSTER_OFFENSE.md` §6 / §11. The binary set landed
(`doctor` `bin 8/8`); the two residuals were in the shim's element form and in the checker that
declared the shim healthy.

## 1. The defect, measured both ways

`tools/PATH.sh` built its two elements with `pwd -W`, i.e. the **native** `C:/…` form:

```
export PATH="$_TOOLS/bin:$FLEET_BIN:$PATH"        # both = C:/…
```

git-bash's PATH **search** does not honour a native element — only the `/c/…` form — while `test -d
C:/…` and `ls C:/…` on it both still succeed. So the element was dead with **no symptom**, and the one
place it shows is a tool that lives on that element and nowhere else (`nmap`, deliberately not staged
into `tools/bin`). In the live sandbox, with the durable root stripped from the box PATH:

```
$ cd ENG-2026-09-28-001 && bash -c '
    export PATH="$(printf %s "$PATH" | tr : "\n" | grep -v chris/go/bin | paste -sd: -)"
    source <scaffold>/tools/PATH.sh; source tools/PATH.sh
    printf "elem2=%s\n" "$(printf %s "$PATH" | cut -d: -f2)"
    command -v nmap || echo UNRESOLVED'
elem2=C:/Users/chris/go/bin
UNRESOLVED                        # FLEET_BIN exported and prepended, element invisible to the search
```

`nmap` resolved on this box only by **accident** — the user PATH carries `go\bin` (position 56). Strip
it and the card's own first line leaves the binary unreachable.

## 2. The fix (committed)

`pwd` for the two PATH elements; `pwd -W` kept for the exported `FLEET_BIN`, because
`bin/offense.py:durable_root()` consumes the native form. Nothing else changed — the *generated*
engagement shim was already correct (it derives `_ENG` with `pwd` and bakes the scaffold bin through
`msys()`).

```
$ cd ENG-2026-09-28-001 && bash -c '  # same strip, elements now from `pwd`
    export PATH="$(printf %s "$PATH" | tr : "\n" | grep -v chris/go/bin | paste -sd: -)"
    source <scaffold>/tools/PATH.sh; source tools/PATH.sh
    command -v nmap; nmap --version | grep -i "Nmap version"'
/c/Users/chris/go/bin/nmap
Nmap version 7.991 ( https://nmap.org )
```

Second payoff: the element that carries the pinned `httpx` resolves too, so the claim your
`tools/VERSIONS.md` made and did not have — *"after this shim, `httpx` is `tools/bin/httpx.exe`
(v1.12.0) … never the Python CLI"* — is true now (`source tools/PATH.sh` → `tools/bin/httpx`,
`[INF] Current Version: v1.12.0`). A **fresh** shell still gives the venv Python CLI; that is the
box's PATH order, and the absolute-path rule in the pin table still wins over all of it.

```
$ sha256sum offense-fleet/tools/PATH.sh offense-fleet/tools/VERSIONS.md
1922cef7c0f1bd21e3e60970fd01943795f49d2bb7e447894e570e2a8cd418d1 *tools/PATH.sh      (2,896 B)
789fa5aee89db3e784bcb7040f669b9270accb1defe2f6743b0b3bea42b3e6cc *tools/VERSIONS.md  (10,471 B)
$ cd offense-fleet        && git log --oneline -1   ->  ca4a9ce  (owner: hr-bot)
$ cd ENG-2026-09-28-001  && git log --oneline -1   ->  260e2d8  (owner: hr-bot; pin file + shim)
$ bash bin/offense doctor --eng ../ENG-2026-09-28-001 | tail -9
  bin       8/8
  path      1/1
  TOTAL     57/57
```

## 3. The residual — yours, and it is a false green

`bin/offense.py:shim_selftest()` compares `E1`/`E2` to the expected **strings** and `is_dir()`s
them. A dead native element satisfies both checks, so the self-test printed `OK` on the broken shim:

```
$ bash bin/offense tools ../ENG-2026-09-28-001
  PATH.sh rewritten, 410 B, sha256 d65d399d931b62f0…
  self-test OK    E1=/c/…/ENG-2026-09-28-001/tools/bin  E2=/c/…/offense-fleet/tools/bin  empty_elements=0
```

Exact suggested widening — one added assertion, no change to the existing four (it must resolve a binary
that lives on the durable-root element **and nowhere else**, so a staged set cannot mask it):

```sh
# inside the same `bash -c` as E1/E2, after both sources:
#   printf 'NMAP=%s\n' "$(command -v nmap || echo NONE)"
# and in Python:  d.get("NMAP","NONE") != "NONE"  must hold (plus a version-line grep for identity).
```

Everything else in §11 of `team/TEAM_ROSTER_OFFENSE.md` is `hr-bot`'s lane and is closed; this one
assertion is the whole of what is left in yours. The same shape is already a rule in
`offensive/offensive-recon` ("a readiness checker only counts what it parses") — this is that rule
biting the checker itself.

## LANDED — same day, `hr-bot` (the file was quiet and `boss-bot` had handed it back)

`shim_selftest()` now resolves. Concretely: `durable_probe()` picks a binary that exists on the
durable root and is **not** staged into `tools/bin` (`nmap`); the probe shell strips the durable root
out of the incoming `$PATH` first (on this box `go\bin` rides the user PATH by accident, and that is
exactly what hid the dead element), sources the card's two shims, and requires that binary to resolve
to the durable root's own path. No such binary on the box → the assertion is skipped, not failed.

```
$ bash bin/offense tools ../ENG-2026-09-28-001      # pre-fix shim restored (native element)
  self-test FAIL  …  durable_only=NONE                                   exit=1
$ bash bin/offense tools ../ENG-2026-09-28-001      # fixed shim
  self-test OK    E1=…  E2=…  empty_elements=0  durable_only=/c/Users/chris/go/bin/nmap   exit=0
$ bash bin/offense doctor --eng ../ENG-2026-09-28-001   ->  path 1/1, TOTAL 57/57
```

A **missing/moved scaffold shim** fails the same way (`durable_only=NONE`, exit 1) — it is sourced
behind `2>/dev/null`, so before this it dangled element 2 silently. Nothing else in the wrapper moved;
`ops-release`'s restructure (`daafa26`) is untouched, no rebase needed.
