# NOTE — video generation now runs on the LightX2V task endpoint (MiniMax-H3)

**From:** hr-bot · **To:** ops-release (deploy lane) + boss-bot (orchestrator)
**Filed:** 2026-09-29 ~21:30Z · **Status: WIRED AND LIVE-PROVEN — nothing outstanding on the happy path.**

## What the user asked

> "wire this to loop-gpt video generation endpoint" + the `curl` POST to
> `https://6abb8c1a84bcc564cb60d1e2.endpoints.huggingface.cloud`
> (`{"model":"drbaph/MiniMax-H3-Turbo-Lora-ComfyUI","inputs":"Hello world!"}`).

## What that endpoint actually is (probed, not assumed)

It is **not** a ComfyUI/`{model,inputs}` endpoint. The root URL is a
**redirect to `/docs`**; `POST /` answers `405 {"detail":"Method Not Allowed"}` and
`GET /v1/models` answers `404`. It is a **LightX2V task API**:

```
GET  /openapi.json        -> {"title":"LightX2V API","version":"1.0.0"}
GET  /v1/service/metadata -> {"nproc_per_node":1,"model_cls":"minimax_h3","model_path":"/models/MiniMax-H3"}
GET  /health              -> {"status":"ok"}                                    HTTP=200 t=1.3s
POST /v1/tasks/video/    -> {"task_id":"89G4-…","task_status":"pending"}
GET  /v1/tasks/{id}/status -> processing x6 -> completed (46.1 s)
GET  /v1/tasks/{id}/result -> HTTP 200  Content-Type: video/mp4  25,487 B  sha256 d36d81d7…ac099f
```

Contract traps, all measured (a `task` is mandatory; the valid set is printed by
the error itself):

```
POST {"task":"bogus_task",...}
 -> "Task 'bogus_task' is not supported by this runner; expected one of: t2av, i2av, l2av, fl2av, ref2av"
POST {"task":"t2av","aspect_ratio":"16:9",...} -> extra_forbidden (aspect_ratio is an IMAGE-task field)
POST {"task":"t2av", ...} with no save_result_path
 -> result endpoint: 404 {"detail":"Task result file does not exist"}
save_result_path outside the server's own root -> 403 {"detail":"Access to this file is not allowed"}
```

The allowed save root is `/opt/LightX2V/save_results/server_cache/outputs` (the two
pre-existing rows in `GET /v1/tasks/` sit there). Text→video = `t2av`,
reference frame→video = `i2av` (`image_path` takes base64 or a data URL) — both
branches read back real bytes:

```
i2av  POST /v1/tasks/video/ {"task":"i2av","image_path":"data:image/png;base64,…","seed":11,
        "save_result_path":"/opt/LightX2V/save_results/server_cache/outputs/loopgpt_i2v_test.mp4"}
      → 4Q6Z-MXNU-VLP7-PIUW-6929  processing x7 → completed (59.7 s)
      → GET /v1/tasks/4Q6Z-…/result  HTTP 200  video/mp4  713,051 B
        (ISO Media MP4, sha256 d076bbde…da1200)
```

## What was changed (commit `c894095`, pushed to `release/owned-staging-20260917`)

| File | Change |
|---|---|
| `backend/src/agent/tools/generateVideo.ts` | new transport: `HF_VIDEO_API=lightx2v` → submit `POST {origin}/v1/tasks/video/`, poll `GET /v1/tasks/:id/status`, download `GET /v1/tasks/:id/result`; helpers `videoTaskApi()`, `videoTaskName()`, `videoTaskSaveDir()`; `t2av`/`i2av` chosen from the reference count |
| `backend/src/agent/__tests__/generateMediaTransport.test.ts` | +4 tests (submit/poll/download, i2av, save-root + failed task, no-task-id + inert-when-unset). **Full suite: 65 files, 1187 passed, 5 skipped**; `tsc --noEmit` clean |
| `backend/env.example` | documents `HF_VIDEO_API`, `HF_VIDEO_SAVE_DIR`; `HF_VIDEO_ENDPOINT` → `HF_VIDEO_ENDPOINT_URL` (the code never read the former) |
| `docs/MEDIA_GENERATION.md` | the endpoint contract + the raw probe |

`backend/.env` (local) also points `HF_VIDEO_ENDPOINT_URL`/`VIDEO_API_URL` at the new
endpoint with `HF_VIDEO_API=lightx2v`; backup at `.env.bak.pre-lightx2v-20260929-171720`.

## Live wiring — DONE

Two variables on the Railway `backend` service (set by hr-bot 2026-09-29 ~21:22Z):

```
HF_VIDEO_API=lightx2v
HF_VIDEO_ENDPOINT_URL=https://6abb8c1a84bcc564cb60d1e2.endpoints.huggingface.cloud
HF_VIDEO_SAVE_DIR=/opt/LightX2V/save_results/server_cache/outputs
```

`HF_TOKEN` needed **no** change: the live token authenticates to the new endpoint
(`GET /v1/service/status` → `HTTP=200`) and to the old Gradio Space alike.

Read-backs (raw):

```
$ curl -s https://loop-gpt.cyou/api/version
{"service":"loop-gpt-backend","revision":"c8940959bca71b46da10b08474a4b876443fd904",
 "startedAt":"2026-09-29T21:23:11.313Z","node":"v22.23.2"}      # = git rev-parse HEAD
$ railway deployment list --service backend
  0b177225-0ab7-4ab7-8f73-82ed87a7d827 | SUCCESS | 2026-09-29 17:22:33 -04:00
```

**End-to-end on the live site** (signed-up probe account, real browser, real
`generate_video` tool call): the turn reported `Generating 4s video at 24fps
(960x544)...` → *"Here's your video — a 4-second clip of ocean waves at sunset.
Specs: 4 seconds · 24fps · 960×544"*; the artifact downloads as
`HTTP/1.1 200  Content-Type: video/mp4  1,137,390 B` (valid MP4, sha256
`9df7788b…2f98ad`), and the endpoint's own registry gained exactly the row the code
generates:

```
85LE-P00V-G4PX-RAUI-6MXH  completed  2026-09-29T21:25:06.015984
  /opt/LightX2V/save_results/server_cache/outputs/loopgpt-mun6q9vt-7ckvi86f.mp4
```

## Open items for the deploy lane

1. **The old Gradio Space is still what the IMAGE path uses** (`HF_IMAGE_ENDPOINT_URL`
   is unchanged) — deliberate; only video moved. Nothing to do.
2. **`HF_VIDEO_MODEL` is now stale** on the live service
   (`thornmaze/WAMU_v3_WAN2.2_I2V_LIGHTNING`). The tool sends no model field on the
   task path, so it is inert — but it is a lie in the env; delete or repoint it.
3. **The endpoint's task registry resets on restart** (one observation: `GET /v1/tasks/`
   went from 4 rows to `{}` mid-session, `total_tasks:0`). If a durable-jobs path
   ever polls a task id across a restart it will read `404 Not Found`; the tool path
   is single-request and unaffected.
4. **`GET /v1/files/download/{path}` also works** (same allowlist) if a signed
   download is ever preferred over the result route.
5. `HF_VIDEO_SAVE_DIR` is that server's own root; if the endpoint is replaced,
   re-probe the 403 before assuming the default.
