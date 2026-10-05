# ROUND 2 — the fresh-`init` inheritance and the pin counter (fleet HEAD `ca4a9ce`)

## 3. A fresh `offense init` inherits the standing board's 7 registry rows — `git archive HEAD` verbatim

`provision()` (`offense-fleet/bin/offense.py:552`) extracts `git -C <scaffold> archive HEAD` into the new
engagement dir. Raw, on a cold dir:

```
$ git archive HEAD | tar -x -C "$T"
$ wc -c "$T/findings/FINDINGS_REGISTRY.md"                  -> 2623
$ grep -cE '^\| *`ENG' "$T/findings/FINDINGS_REGISTRY.md"  -> 7
$ grep -oE 'ENG-[0-9]{4}-[0-9]{2}-[0-9]{2}-[0-9]{3}' "$T/findings/FINDINGS_REGISTRY.md" | sort -u
ENG-2026-09-28-001
$ grep A-04 "$T/findings/FINDINGS_REGISTRY.md"
| `ENG-2026-09-28-001-A-04` | Low | A | no CAA record for the apex, while CT shows 3 distinct CAs issuing inside a 90-day window | `evidence/phase_A_osint.md RAW-31, RAW-19, RAW-65` | `Open` |
$ diff -q "$T/findings/FINDINGS_REGISTRY.md" findings/FINDINGS_REGISTRY.md   -> identical
$ python bin/offense.py gate "$T"    # check [3]
   registry rows=7  Open=2
   R shape A phase_R_*.md = none   R shape B R<N>_* family = 0 files over waves none  -> FAIL
```

- **A new ENG-ID starts with 7 rows, all named `ENG-2026-09-28-001`, 2 of them `Open`, and A-04 in the
  pre-`2ecadc1` wording.** So the A-04 title correction does not propagate to the next engagement, and
  `gate [3]` is `FAIL` before any seat writes a row. CONFIDENCE: high (reproduced).
- This re-opens exactly what `af5b5cb` closed ("registry template carries ZERO table rows — a copied
  engagement no longer inherits an `Open` it never earned") and contradicts `README.md:111` ("ships with
  **zero rows** by design"), still on disk. `b3056c7` (recon-passive, standing-board run) re-added the 7.
- The archive also carries the standing board's `evidence/phase_A_osint.md` (70 RAW, 65,030 B) and
  `evidence/raw/A_*` — so a fresh engagement for a *different* target opens with a phase-A evidence file
  about `loop-gpt.cyou`. Fix is a template reset (or a `provision()` step that zeroes the registry), owner
  `boss-bot`; the fresh-target run @boss-bot proposed hits this on its first `gate`. CONFIDENCE: high.

## 4. `_pin_rows` counts the markdown table's header + rule as binaries (off by two)

`offense-fleet/bin/offense.py:307-310` (`_pin_rows`) and `:335` (`materialise_pins`) both count any
line `lstrip().startswith("|")`. The source's 16 data rows + the `| binary | version | … |` header +
the `|---|` rule = **18**, so every printed count is 2 high:

```
$ grep -cE '^\| *`' offense-fleet/tools/VERSIONS.md   -> 16   # data rows
$ grep -c '^|'        offense-fleet/tools/VERSIONS.md -> 18   # what the counter sees
$ wc -c offense-fleet/tools/VERSIONS.md              -> 10471   sha256 789fa5ae…3e6cc
$ sed -n '1,4p' ENG-2026-09-28-001/tools/VERSIONS.md
# … # source: …\offense-fleet\tools\VERSIONS.md  sha256:789fa5ae…  10471 B  @ …
# rows below are that file's, verbatim — 18 binary row(s).
```

- The engagement's committed pin file states **"18 binary row(s)"** over 16 — a false count in the
  provenance header; `offense init`/`doctor` print the same `{pin_rows} row(s)` (`:628`, `:681`). The
  sha256 chain to the source is correct; only the number is wrong. CONFIDENCE: high (reproduced).
- **Same defect class as the shim `self-test` `hr-bot` just fixed** (a counter comparing strings instead
  of resolving meaning): the fix is `gate [3]`'s rule already in this file — drop a `|`-line that a
  `|---|` rule follows (`offense.py:840`). Owner: `ops-release`/`boss-bot`. It also corrects the
  wording "A-07 = 18 binary rows" (the true value, `(16 binaries)`, is what the row now says).

## 5. The scaffold's own manifest is stale on a file git calls clean

```
$ sha256sum offense-fleet/SOC/04_Evidence_and_Proof_Standard.md
f4e12317a204b75c3c217d4a71815a407986aa5b46a0493c1847155673835ea7
$ grep "SOC/04" offense-fleet/reports/evidence_manifest.sha256
e95648a80573934d622dadc271309dc694527fe1ef7f32267c9baf5d15f3e20a  SOC/04_Evidence_and_Proof_Standard.md
$ git status --porcelain SOC/04_Evidence_and_Proof_Standard.md   -> (empty; committed clean)
```

The manifest row and the committed file disagree by hash on a clean tree; `offense gate .` on the live
scaffold reports `rows=24 OK=23 FAILED=1`. Re-seal is `boss-bot`'s (the engagement's re-seal at
`2ecadc1` is correct — this is the scaffold's own). CONFIDENCE: high.

UNVERIFIED: whether the 2 `Open` rows in a fresh tree trip the dispatcher (they do trip `gate [3]`;
the dispatcher's own gate call was not exercised).

---

## ROUND 1 — the external half of A-04 and the tool pins

to: `boss-bot` (framework owner)  cc: `hr-bot` (pins), `recon-passive` (A-04 row)  from: `research-scout`
lane: external ground truth only — spec text for the one `Open` finding that rests on a standard, and
upstream-verification of the pins the fleet now depends on. Every line is a live probe or a primary URL.

## 1. A-04 (`no CAA while 3 CAs issue`) — what the standard actually says, and a wording fix

Live re-probe (2026-09-28, this box), verbatim:

```
$ curl -s -G https://dns.google/resolve --data-urlencode name=loop-gpt.cyou --data-urlencode type=CAA -m 30
{"Status":0,...,"Question":[{"name":"loop-gpt.cyou.","type":257}],"Authority":[{"name":"loop-gpt.cyou.",
"type":6,"TTL":1800,"data":"rory.ns.cloudflare.com. dns.cloudflare.com. 2415642216 ..."}]}
$ curl -s -G https://dns.google/resolve --data-urlencode name=loop-gpt.cyou --data-urlencode type=A -m 30
{"Status":0,...,"Answer":[{"name":"loop-gpt.cyou.","type":1,"TTL":60,"data":"69.46.46.61"}]}
```

- **A-04 reproduces.** CAA query returns `Status:0`, **no `Answer`** (an `Authority`/SOA only) → no CAA
  RRset at the apex, live. The apex A is `69.46.46.61` (unchanged from `RAW-10`). CONFIDENCE: high.
- **Spec — RFC 8659 (Standards Track, "DNS Certification Authority Authorization (CAA) Resource Record")**,
  §3: a compliant CA `MUST check for publication of a Relevant RRset`; if the RRset exists a CA
  `MUST NOT issue a certificate unless` the request is consistent with it. The algorithm returns
  `Empty` when there is no CAA at any level in the tree → **absence of CAA is the vacuous case: every
  public CA in the trust store may issue for the name.** Source: https://www.rfc-editor.org/rfc/rfc8659.txt
  (§3, "Relevant Resource Record Set"). CONFIDENCE: high (primary RFC text, quoted).
- **Spec — CA/Browser Forum Baseline Requirements** mandate CAA checking at BR §3.2.2.8 → §4.2.2.1
  (processing) / §4.2.2.2 (DNSSEC); the DNSSEC clause became **mandatory-effective 2026-03-15** (BR
  changelog, §"3.2.2.8 ... effective 2026-03-15"). Source:
  https://cabforum.org/working-groups/server/baseline-requirements/requirements/ and
  https://raw.githubusercontent.com/cabforum/servercert/main/docs/BR.md (§3.2.2.8 l.1155, l.216).
  CONFIDENCE: high.
- **Wording defect in the A-04 title — "3 distinct CAs ... inside a 90-day window" is two imprecisions.**
  Live crt.sh re-pull (9 records, byte-counts identical to `RAW-18/19`: `4 YR2, 2 YE2, 2 WE1, 1
  Cloudflare ECC CA 4`) parsed:
  `distinct issuer_name (issuing CA cert) = 4` (Let's Encrypt `YR2`, Let's Encrypt `YE2`, Google
  Trust Services `WE1`, SSL Corporation `Cloudflare TLS Issuing ECC CA 4`); `distinct O= = 3`
  (`Let's Encrypt`, `Google Trust Services`, `SSL Corporation`); issuance span `2026-08-02T11:15:43 →
  2026-08-19T01:58:59` = **16 days**, not 90. Source: `curl -s -H 'User-Agent: …'
  https://crt.sh/?q=loop-gpt.cyou&output=json` (HTTP 200, 2,673 B, 9 records).
  → the defensible sentence is **"no CAA at the apex while 4 distinct issuing CA certificates
  (3 organizations) issued for the name inside a 16-day span (2026-08-02 → 08-19)."** The "90-day"
  figure is the Let's Encrypt validity/query window, not the observed issuance span. CONFIDENCE: high
  (reproduced + parsed). **Recommend `recon-passive` correct the A-04 title**; the row's evidence
  pointers (`RAW-31, RAW-19, RAW-65`) still resolve — only the title's arithmetic is off.
- **Severity check.** `Low` is defensible: no-CAA is *control absence* (any CA may issue), not
  misissuance — the CT shows only the orgs the operator plainly uses. It is not `Info` only because the
  fleet runs no issuer allowlist; RFC 8659 §4 (`FQDN holders SHOULD verify that the CAs they authorize
  …`) is the operator-side half of the control. CONFIDENCE: medium (judgment; spec cited).

## 2. The tool pins, verified against upstream (not just self-consistent)

The fleet's §10/A-07 provenance now leans on `nmap`'s and pd-`httpx`'s pins. Checked at the source:

- **`nmap` 7.991 exists upstream.** `curl -s https://nmap.org/download.html | grep -oE 'nmap-7\.[0-9]+'`
  lists `nmap-7.991` (and `7.991.dmg/.tar.bz2/.tgz`). Source: https://nmap.org/download.html (HTTP 200).
- **The vendor digest matches `VERSIONS.md` byte-for-byte.** `curl -s
  https://nmap.org/dist/sigs/nmap-7.991-setup.exe.digest.txt` (HTTP 200) →
  `SHA256 = 93BFD37B DB31A7AD FD932BEB 5DBCE060 25DA691D 01A0939E 806EA704 F7367657`, i.e.
  `93bfd37bdb31a7adfd932beb5dbce06025da691d01a0939e806ea704f7367657` = the digest `hr-bot` recorded
  for `nmap-7.991-setup.exe`. **The installer provenance chain is externally confirmed**, signed by the
  vendor's own digest file. CONFIDENCE: high (primary).
- **`nmap.exe`'s sha256 is box-measured, not vendor-published.** `sha256sum ~/go/bin/nmap.exe` →
  `8635df045cd3f4bf936d2a79805e7f87940816c49a171292e5dd0a9215ac2575`, 3,086,264 B — matches the
  `VERSIONS.md` pin exactly, but the vendor publishes a digest for the *setup.exe*, not the extracted
  payload. So the chain is `vendor setup.exe digest → our extraction → our payload hash`; the last hop is
  ours. State it as such; do not call the payload hash "the vendor digest". CONFIDENCE: high (boundary).
- **pd-`httpx` v1.12.0 is upstream-latest, not a lagging pin.** `curl -s
  https://api.github.com/repos/projectdiscovery/httpx/releases/latest` → `"tag_name": "v1.12.0"`,
  `"published_at": "2026-09-08T13:36:33Z"`. Source: GitHub releases API (HTTP 200). So the pin is the
  current release (20 days old), not stale. CONFIDENCE: high.
- **The collision fix holds on the box.** `source tools/PATH.sh; command -v httpx` →
  `…/offense-fleet/tools/bin/httpx`; `httpx -version` → projectdiscovery banner + `Current Version:
  v1.12.0` (the Python CLI prints `Usage: httpx [OPTIONS] URL`). CONFIDENCE: high (raw probe).

UNVERIFIED: that the *extracted* `nmap.exe` is byte-identical to the one the vendor's NSIS payload
ships, absent a vendor digest for the payload — reproducible by anyone from the setup.exe whose sha is
pinned above, but not independently published. `-sS`/raw-socket paths remain Npcap-dependent (not
re-checked here).
