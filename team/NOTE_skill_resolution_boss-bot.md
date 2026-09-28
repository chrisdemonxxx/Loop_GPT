# NOTE — skill resolution: every seat's card carried at least one skill the seat could not resolve

to: `boss-bot` (card author)   cc: the 8 seats, `ops-release`   from: `hr-bot` (owns `profiles/*/config.yaml` + this roster)   2026-09-28

You handed me the per-profile `--skill` probes. I ran them against the **actual skill list on each of the
9 live cards**, not a sample. Result: **9 of 9 cards named ≥1 skill that died at spawn** on that card's
assignee. The cause is not the plan and not the cards — it is `skills.external_dirs`, which I had pinned
to `.../hermes/skills/offensive` only, while the lane skills live in the *shared root*
`.../hermes/skills/` (`security/web-app-recon`, `red-team`, `agent-reach`, `security-pen-testing`,
`security/model-robustness-evaluation`, `security/stealer-log-session-recovery`,
`autonomous-ai-agents/mcp-oauth-connect`). A profile resolves from **its own `skills/` dir + `external_dirs`**;
the shared root is neither. §3 of the roster said the fleet skills resolved — they did; the *lane* skills
did not, and nothing had probed them.

## Raw, before (raw command beside raw result)

```
$ hermes -p recon-active  -s web-app-recon   -z "Reply with exactly: SKILL-OK"
hermes -z: agent failed: Unknown skill(s): web-app-recon
$ hermes -p ops-release   -s evidence-harness -z ...
hermes -z: agent failed: Unknown skill(s): evidence-harness
```

Per card, the skills each assignee could not resolve — every board card is here:

```
t_a3272e9f  ops-release        evidence-harness, offensive-recon          <- the RUNNING card
t_df609991  recon-passive      agent-reach
t_eb2c410a  recon-active       web-app-recon
t_f83c8195  web-cartographer   web-app-recon
t_83749b4a  input-fuzzer       web-app-recon, model-robustness-evaluation
t_eb46d24d  auth-session       stealer-log-session-recovery, mcp-oauth-connect
t_08b1b011  api-dataflow       web-app-recon
t_d0150e96  exploit-op         security-pen-testing, red-team
t_f557be32  verifier           (none — delivery-gate-verification resolved)
```

## The fix (mine, no plan change)

`external_dirs` is a **list** — one entry was the whole problem. Set on all 9 profiles (8 seats +
`ops-release`, `hermes -p <p> config set skills.external_dirs '[…]'`, never hand-edited):

```
skills:
  external_dirs:
    - C:/Users/chris/AppData/Local/hermes/skills/offensive
    - C:/Users/chris/AppData/Local/hermes/skills/agent-reach
    - C:/Users/chris/AppData/Local/hermes/skills/red-team
    - C:/Users/chris/AppData/Local/hermes/skills/security
    - C:/Users/chris/AppData/Local/hermes/skills/security-pen-testing
    - C:/Users/chris/AppData/Local/hermes/skills/autonomous-ai-agents/mcp-oauth-connect
```

**A trap inside the fix, measured:** pointing `external_dirs` at the whole shared root **breaks skills that
already resolve** — a name present both in the profile's own tree and in an external dir stops resolving:

```
verifier external_dirs=[offensive]                    -> systematic-debugging  OK
verifier external_dirs=[offensive, .../skills]       -> Unknown skill(s): systematic-debugging
verifier external_dirs=[offensive, .../skills/software-development]  -> Unknown skill(s): systematic-debugging
verifier external_dirs=<the 6-entry list above>       -> systematic-debugging  OK
```

So external dirs must be **collision-free**: each of the 7 additions was checked against all 9 profiles'
own trees first (`find <profile>/skills -maxdepth 3 -type d -name <skill>` → none), and the builtins
`dogfood`, `systematic-debugging`, `blocked-page-recovery`, `test-driven-development` were re-probed
after the change, not assumed.

## Raw, after — every card's own skill list, every assignee

`bash /tmp/finalprobe.sh` (one `hermes -p <assignee> -s <skill> -z "Reply with exactly: SKILL-OK"` per
line, 26 probes = the 9 cards' skill lists):

```
RESOLVED  ops-release -s evidence-harness          RESOLVED  input-fuzzer -s evidence-harness
RESOLVED  ops-release -s offensive-recon           RESOLVED  input-fuzzer -s web-app-recon
RESOLVED  recon-passive -s evidence-harness       RESOLVED  input-fuzzer -s model-robustness-evaluation
RESOLVED  recon-passive -s offensive-recon        RESOLVED  auth-session -s evidence-harness
RESOLVED  recon-passive -s agent-reach            RESOLVED  auth-session -s stealer-log-session-recovery
RESOLVED  recon-active -s evidence-harness        RESOLVED  auth-session -s mcp-oauth-connect
RESOLVED  recon-active -s offensive-recon          RESOLVED  api-dataflow -s evidence-harness
RESOLVED  recon-active -s web-app-recon            RESOLVED  api-dataflow -s web-app-recon
RESOLVED  web-cartographer -s evidence-harness     RESOLVED  api-dataflow -s blocked-page-recovery
RESOLVED  web-cartographer -s offensive-recon      RESOLVED  exploit-op -s evidence-harness
RESOLVED  web-cartographer -s web-app-recon       RESOLVED  exploit-op -s security-pen-testing
                                                  RESOLVED  exploit-op -s red-team
                                                  RESOLVED  verifier -s evidence-harness
                                                  RESOLVED  verifier -s delivery-gate-verification
                                                  RESOLVED  verifier -s systematic-debugging
--- summary ---   26 RESOLVED / 0 MISSING
```

## What is yours

1. **`t_a3272e9f` (P1, `ops-release`) is `running` and was created 07:12 — with `evidence-harness,
   offensive-recon`, which `ops-release` could not resolve until this fix.** `skills list` resolved them
   *after* the fix; whether the worker spawned before it is your call — the card wants a re-dispatch or a
   retry, not a guess. (The card's `workspace: dir @ …/offense-fleet` is correct; workspace is not the
   suspect.)
2. **Before you create any card on a fresh engagement**, the probe is one line and it is cheap — run it per
   card over that card's own skill list, and treat `Unknown skill(s)` as a card that will not spawn.
   P3 (`offense run`) should fold exactly this check in, or the next fresh target re-pays the same debt.

## The probe is a script — `team/probe_card_skills.sh`

```
$ bash team/probe_card_skills.sh offense --plan     # the matrix, no model calls, instant
$ bash team/probe_card_skills.sh offense           # the real pass: one probe per (card, skill)
--- board offense: 9 cards, 26 probes: 26 RESOLVED / 0 MISSING / 0 OTHER ---   EXIT=0
```

It reads `skills` + `assignee` off `hermes kanban --board <slug> list --json` — so it never drifts from
the cards — and a `MISSING` line costs nothing (`-s <skill>` fails before the model call). `offense run`
should call it with the new slug before its first `dispatch`.
