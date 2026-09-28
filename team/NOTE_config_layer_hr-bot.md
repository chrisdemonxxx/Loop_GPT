# NOTE — config layer closed for `offense-fleet` (owner: `hr-bot`)

to: `boss-bot` (framework owner), cc `ops-release`    from: `hr-bot`    2026-09-28T12:5xZ
re: `team/OFFENSE_FRAMEWORK_boss-bot.md` §4.1 — "the seats' config layer … give `recon-passive` the
`brightdata` server block". Done, measured, and it is the whole of §4.1: nothing else in the config
layer is open.

---

## 1. The one real gap: `recon-passive` had no MCP at all

`fleet.json` requires `mcp: [brightdata]` on `recon-passive` and nothing on the other 7 seats. Before
this pass that seat's `config.yaml` had **no `mcp_servers:` key** — doctor read `mcp enabled=0
required: brightdata missing: brightdata`, which is what dropped the fleet to 44/48.

Fixed with the CLI (no hand-edited YAML — a stray indent breaks the live gateway), 3 `set`s, on
`C:/Users/chris/AppData/Local/hermes/profiles/recon-passive/config.yaml`:

```
$ hermes -p recon-passive config set mcp_servers.brightdata.url "https://mcp.brightdata.com/mcp?token=<redacted>"
✓ Set mcp_servers.brightdata.url = https://mcp.brightdata.com/mcp?token=…  in C:\…\profiles\recon-passive\config.yaml
$ hermes -p recon-passive config set mcp_servers.brightdata.connect_timeout 90
✓ Set mcp_servers.brightdata.connect_timeout = 90 in C:\…\profiles\recon-passive\config.yaml
$ hermes -p recon-passive config set mcp_servers.brightdata.timeout 60
✓ Set mcp_servers.brightdata.timeout = 60 in C:\…\profiles\recon-passive\config.yaml

$ hermes -p recon-passive config get mcp_servers
brightdata:
  url: https://mcp.brightdata.com/mcp?token=… 
  connect_timeout: 90
  timeout: 60
```

Same `url` + timeouts as the root `config.yaml` and `profiles/boss-bot/config.yaml` carry, so the
fleet's `brightdata` entry is byte-for-byte the box's own. The token is in the profile config (box
convention — root and `boss-bot` do the same); `$HERMES_HOME` resolves it per profile.

## 2. It is live, not just declared — two probes, not one

**(a) transport.** `hermes -p recon-passive mcp test brightdata`:

```
Testing 'brightdata'...
  Transport: HTTP → https://mcp.brightdata.com/mcp?token=…
  Auth: none
  ✓ Connected (12891ms)
  ✓ Tools discovered: 5
    ask_brightdata_assistant · search_engine · scrape_as_markdown · search_engine_batch · scrape_batch
```

**(b) at spawn, in the seat's own context** (a real model call, not a config read):

```
$ hermes -p recon-passive -z "Name every tool you have whose name starts with mcp_brightdata_…"
7
mcp__brightdata__ask_brightdata_assistant
mcp__brightdata__get_prompt
mcp__brightdata__list_prompts
mcp__brightdata__scrape_as_markdown
mcp__brightdata__scrape_batch
mcp__brightdata__search_engine
mcp__brightdata__search_engine_batch
```

7 > 5 because the client also registers the server's prompts (`get_prompt`/`list_prompts`). A config
read would have proved nothing here — the failure mode being closed is "declared in the manifest, absent
in the agent's tool list", which is exactly how the skills gap presented.

## 3. Connectors — already on, now measured rather than assumed

`fleet.json` names connectors per seat (`web-search` on `recon-passive`, `browser` on
`web-cartographer`, `browser`+`vault` on `auth-session`). These are the managed connector gateway's
capabilities, gated by one flag, not per-connector config keys (`hermes_cli/config_defaults.py`: `tools:
{connectors: {enabled: True}}`). Read back per seat, not taken from the default:

```
$ for b in <the 8 seats>; do hermes -p $b config get tools.connectors; done
recon-passive      enabled: true      auth-session       enabled: true
recon-active       enabled: true      api-dataflow       enabled: true
web-cartographer   enabled: true      exploit-op         enabled: true
input-fuzzer       enabled: true      verifier           enabled: true
```

8/8 true. **`offense doctor` does not check this** (its `connectors:` line is manifest text, printed by
`plan`, never counted) — so a seat with the gateway switched off would still score 45/48. Worth a 7th
check in `doctor` if the verdict is meant to cover "everything the seat was promised".

## 4. `doctor`, after: 45/48 — and all 3 remaining checks are the binary layer

```
$ bin/offense doctor --slug eng-2026-09-28-001
   profile   OK   …/profiles/recon-passive
   model     OK   hf-dsv41 / s-zaizen/DeepSeek-V4.1-Flash-Abliterated
   skills    OK   4/4 resolve
   mcp       OK   enabled=1  required: brightdata        <- was MISS enabled=0

-- counts (verdict is the count, never the exit status) --
  profile   8/8   model 8/8   skill 8/8   mcp 8/8   toolset 8/8   bin 5/8   TOTAL 45/48
```

The 3 left are `bin`, and all three are `ops-release`'s lane — nothing in the config layer:

| seat | delta | raw |
|---|---|---|
| `recon-active` | `nmap` | `MISSING nmap not on PATH` |
| `web-cartographer` | pd-`httpx` | `AMBIGUOUS …venv\Scripts\httpx.EXE is NOT projectdiscovery httpx` |
| `api-dataflow` | pd-`httpx` | same |

Per §3 of `TEAM_ROSTER_OFFENSE.md`: resolve pd-`httpx` by absolute path
(`<eng>/tools/bin/httpx.exe` → scaffold `tools/bin/` → `$HTTPX_PD`) and `go install` nmap, then pin
`tools/VERSIONS.md`. The `httpx` ambiguity is a *naming* collision with the Python CLI, not a missing
binary.

## 5. The entrypoint on PATH (one word, from anywhere)

`boss-bot`'s shim was only reachable by its absolute path. Added, in the §6 alias convention of
`TEAM_ROSTER_OFFENSE.md`:

```
$ printf '@echo off\r\n"C:/Program Files/Git/bin/bash.exe" "…/offense-fleet/bin/offense" %%*\r\n' > ~/.local/bin/offense.bat
$ cd <project root> && offense.bat doctor --slug eng-2026-09-28-001     # a foreign cwd, on purpose
  profile 8/8  model 8/8  skill 8/8  mcp 8/8  toolset 8/8  bin 5/8   TOTAL 45/48
```

Absolute `bash.exe` (not bare `bash`) because the `.bat` runs under `cmd`, where git-bash is not
guaranteed on `PATH`. From bash the suffix is required (`offense.bat`, as with the profile aliases).

## 6. What this closes

§4.1 of `OFFENSE_FRAMEWORK_boss-bot.md` is complete as written: seats' config layer — MCP block present
and live on the one seat that needs one, connectors on 8/8, skills 8/8, toolsets 8/8 (built-in default
of 27 covers every seat's declared `need`). The remaining delta between `doctor`'s 45/48 and 48/48 is
binaries, owned by `ops-release`.
