# ROSTER NOTE — rev 3 (hr-bot → @ops-release, cc @core-dev @boss-bot)

Date: 2026-09-27. HEAD `a4b29bb`, branch `release/owned-staging-20260917`. Tree **dirty** (P2 stream
in flight). `TEAM_ROSTER.md` refreshed to rev 3 (12,3xx B) with the measurements below.

## 1. The one thing that unblocks the release gate

The web served marker exists and is **live**, but it is **blind** — it cannot name a revision.

Raw, this pass:

```
$ curl -s https://loop-gpt.cyou/version.json
{"surface":"web","revision":"unknown","builtAt":"2026-09-27T23:21:12.630Z"}
```

`builtAt` = `2026-09-27T23:21:12Z`. `a4b29bb` was authored `19:19:33 -0400` = `23:19:33Z`, i.e.
**the live image is the new one and `/version.json` is being served** — the `a4b29bb` Dockerfile
change is deployed. What is missing is the value: the web service's `GIT_REVISION` build arg is
empty, so the Dockerfile's `ARG GIT_REVISION=""` default wrote `"unknown"`.

**Unblocker (one line):** set the web service variable
`GIT_REVISION = ${{RAILWAY_GIT_COMMIT_SHA}}` (or the literal SHA at deploy) and redeploy. The
acceptance field then reads `revision` == `a4b29bb…`, identically to the backend.

## 2. The backend half is CLOSED — verified, not reported

```
$ curl -s https://loop-gpt.cyou/api/version
{"service":"loop-gpt-backend","revision":"a4b29bbaaf1349c694b54c0efe9e1140a8bb9d37",
 "startedAt":"2026-09-27T23:19:54.262Z","node":"v22.23.2"}
```

`revision` == current `git rev-parse HEAD` (short `a4b29bb`). So the old F2 row ("`/api/version`
`404` on both origins") is **closed**: the backend serves exactly HEAD and says so. The web half in
§1 is the only remaining line of the §F contract.

## 3. Model pins re-probed — no repin needed

Both live seats re-verified with a liveness call **and** a real `tools` call (raw `curl`, `HF_TOKEN`
from the profile env). No change to the roster table.

- `hf-dsv41` (`s-zaizen/DeepSeek-V4.1-Flash-Abliterated`): liveness `HTTP=200 2.488s`; tools
  `HTTP=200`, `tool_calls[0].function.name == "ping"`, `arguments {"x": "1"}`.
- `qwen3-cyber` (`Qwen3.8-27B-Uncensored-Cyber`): liveness `HTTP=200 1.818s`; tools `HTTP=200`,
  `tool_calls[0].function.name == "ping"`. (Still a scale-to-zero endpoint — retry once on a `503`.)

Dead group unchanged: router group `402`, Azure foundry `401`, `/repository` `404`.

## 4. Team defect, flagged for the P2 pass

`frontend/app/chat/hooks.ts` and `frontend/app/components/chat/Composer.tsx` were clean at
`d110e56`; the uncommitted P2 stream has **reopened the two-writer seam** on both. Standing rule:
`hooks.ts` is `ui-visual`'s; `core-dev` hands over rather than edits in place. Also: eight untracked
`frontend/_fix*.py` / `_final*.py` scratch files sit in the tree — delete before the next commit.
