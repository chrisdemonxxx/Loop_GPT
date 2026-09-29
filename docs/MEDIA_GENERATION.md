# Media generation — architecture, wiring, and ref2lock

**Status: live-verified 2026-09-23.** Image, text-video, reference-image video,
vision, and ref2lock (identity-locked) image/video editing all run against
production with the HF token in `HF_TOKEN`.

## Endpoints (all on the same Gradio Space)

| Surface | Env | Space endpoint | Model |
|---|---|---|---|
| Image (text) | `HF_IMAGE_ENDPOINT_URL` | `/generate_image` | Chroma1-HD (uncensored 8.9B) |
| Image **edit** (ref2lock) | `HF_IMAGE_ENDPOINT_URL` | `/edit_image` | Chroma1-HD img2img (shared weights) |
| Video (text → image → video) | `HF_VIDEO_ENDPOINT_URL` | `/image_to_video` | Chroma1-HD + WAN 2.2 I2V 14B Lightning |
| Video (from a start frame) | `HF_VIDEO_ENDPOINT_URL` | `/generate_video` | WAN 2.2 I2V 14B Lightning |
| Vision | `HF_VISION_ENDPOINT_URL` + `HF_VISION_MODEL` | — | DeepSeek V4.1 Flash (H200×4) |
| TTS | `HF_TTS_ENDPOINT_URL` (optional) | — | Kokoro-82M |

The Space is `red-kit/nsfw-media-studio` (private, A100-large). The backend
authenticates with `HF_TOKEN` on every call, including file downloads.

## Video task API — LightX2V / MiniMax-H3 (wired 2026-09-29)

A dedicated HF endpoint can serve video as an **async task API** instead of a
Gradio call. Set:

| Env | Value |
|---|---|
| `HF_VIDEO_ENDPOINT_URL` | the endpoint origin, e.g. `https://<id>.endpoints.huggingface.cloud` |
| `HF_VIDEO_API` | `lightx2v` (any other value keeps the Gradio / `{inputs,parameters}` paths) |
| `HF_VIDEO_SAVE_DIR` | optional; defaults to `/opt/LightX2V/save_results/server_cache/outputs` |

Contract (probed live 2026-09-29, `Authorization: Bearer $HF_TOKEN`):

- `GET /v1/service/metadata` → `{"nproc_per_node":1,"model_cls":"minimax_h3","model_path":"/models/MiniMax-H3"}`
- `POST /v1/tasks/video/` → `{"task":"t2av|i2av|l2av|fl2av|ref2av", "prompt", "seed", "num_frames",
  "size":[h,w], "save_result_path", "image_path"}` → `{"task_id","task_status","save_result_path"}`.
  `task` is **required** ("task is required when the runner supports multiple tasks"; an unsupported
  one answers `Task 'x' is not supported by this runner; expected one of: t2av, i2av, l2av, fl2av, ref2av`).
  `image_path` accepts a base64 or data-URL frame; `aspect_ratio` is an *image*-task field and is
  rejected (`extra_forbidden`) on video tasks.
- `GET /v1/tasks/{id}/status` → `{"status":"pending|processing|completed|failed"}` (a ~46 s task: submit
  `21:09:27` → `completed 21:10:21`).
- `GET /v1/tasks/{id}/result` → the MP4 bytes — **only when `save_result_path` was set**; omitted, the
  task answers `{"detail":"Task result file does not exist"}`. A save path outside the server's own root
  answers `403 {"detail":"Access to this file is not allowed"}` — hence `HF_VIDEO_SAVE_DIR`.

`generate_video` maps a text prompt to `t2av` and any reference frame to `i2av`, and polls the status
inside the same wall-clock budget as the other media paths.

Raw (2026-09-29, `curl`, 25,487 B, `Content-Type: video/mp4`, sha256 `d36d81d7…ac099f`):

```
POST /v1/tasks/video/ {"task":"t2av","prompt":"A cinematic slow pan over ocean waves …","seed":42,
  "save_result_path":"/opt/LightX2V/save_results/server_cache/outputs/loopgpt_roster_t2av.mp4"}
  → {"task_id":"89G4-UM95-YDFL-854O-R3BM","task_status":"pending","save_result_path":null}
GET  /v1/tasks/89G4-UM95-YDFL-854O-R3BM/status   → processing ×6 → completed (46.1 s)
GET  /v1/tasks/89G4-UM95-YDFL-854O-R3BM/result   → HTTP 200 video/mp4 25,487 B
```

## ref2lock — how identity is preserved

`ref2lock` means the reference anchors the subject. Two paths:

1. **Image** — attaching an image (or passing `image_prompt`) routes
   `generate_image` to the **edit** endpoint: Chroma img2img at `strength`
   (default `0.6`; 0.45–0.7 keeps faces recognisable). The prompt changes the
   scene/outfit; the person stays. Text-only prompts use text-to-image.
2. **Video** — `generate_video` accepts `lock_strength`. When a reference is
   present and `lock_strength` is set, the tool first re-renders the
   reference with the prompt at that strength (via `/edit_image`) and then
   animates the **locked** frame. Omit `lock_strength` to animate the exact
   reference frame.

`strength` semantics: lower = closer to the reference (more "clone"), higher =
more prompt influence (more change). ~0.5 is a good default for "same person,
different scene".

## Face lock — near-exact identity transplant

`ref2lock` above anchors the subject; **face lock** transplants the exact face.
The Space adds:

| Space endpoint | What it does |
|---|---|
| `edit_image(..., face_swap=True)` | img2img ref2lock **then** an inswapper transplant of the reference face |
| `swap_face(target, source)` | standalone transplant of the source face onto a target image |
| `face_metrics(a, b)` | ArcFace cosine similarity (JSON) — the identity score |

Stack: **SCRFD-10G** (detect) + **ArcFace-R50** (recognise) + **inswapper_128**
(swap), on **CPU onnxruntime** (no GPU needed). The model's own 512×512
ArcFace→latent `emap` ships as base64 text (`emap.b64`), so the Space repo stays
binary-free. `face_swap` logs `cosine_before`/`cosine_after` on every call.

**Measured (2026-09-24, ArcFace cosine vs the reference):**

| Stage | cosine |
|---|---|
| img2img only (`strength` 0.6) | 0.62–0.65 |
| after the face transplant (Space) | **0.85–0.87** |
| app artifact — image (attach + "make her NSFW") | **0.84** |
| app artifact — video first frame (attach + `lock_strength` 0.6) | **0.862** |

For reference: ArcFace cosine ≳ 0.4–0.5 is "same person"; 0.85+ is a close
identity match. The backend exposes `face_lock` on `generate_image` (default
**on** when a reference exists; set `false` for a softer img2img-only match) and
uses the same transplant in `generate_video`'s `lock_strength` step.


### Verified

- Space `/edit_image` on a copper-red-haired, green-eyed, freckled portrait →
  same identity (vision: `SAME_PERSON=YES`) with the prompt applied.
- App-level attach + "make her NSFW" → image artifact, same identity.
- App-level reference video with `lock_strength=0.6` → mp4 whose **first
  frame** is the same woman.

## Image quality (2026-09-25)

Four fixes took Chroma1-HD from "soft and occasionally glitched" to sharp:

1. **fp32 VAE decode.** The Chroma pipeline ignores `vae.config.force_upcast` and
   decodes in bf16 — visibly soft. The Space upcasts the VAE and wraps
   `encode`/`decode` to run in fp32, handing bf16 latents back to the transformer
   (and casting `DiagonalGaussianDistribution`'s cached `mean`/`std` too).
2. **The model card's recipe.** `num_inference_steps=40`, `guidance_scale=3.0`,
   and the card's quality negative prompt. The backend no longer overrides a
   negative-prompt textbox with an empty string.
3. **A glitch guard.** Chroma1-HD diverges for a fraction of random seeds into a
   high-frequency "neon noise" frame (edge energy ≈ 3× a normal photo). The Space
   detects it (mean |Δ| on luma > 0.035) and retries with a fresh seed.
4. **Framing + prompt sanitizing (the reference path).** The transplant crops a
   128 px face, so the text-to-image pass must frame the subject close.
   `scene_prompt()` strips reference-laden phrasing ("the same woman", "keep her
   exact face" — which glitches a t2i into multi-figure neon chaos) and appends
   `close-up portrait, sharp focus, natural skin texture` unless the user named a
   framing.

| | before | after |
|---|---|---|
| plain t2i | 7/10 sharp, "acceptable" | **9/10 sharp, 9/10 artifacts → "great"** |
| reference path (attach + "make her NSFW") | 6/10, glitched ~1/3 of seeds | **clean (edge 0.011), 0.81 ArcFace identity** |

## Operational notes

- **`preload_from_hub` and the HF cache.** Do NOT add `preload_from_hub` to the Space: it downloads as root, making the HF/Xet cache root-owned, so *runtime* model downloads (e.g. Chroma on the first image call after a rebuild) fail with `Permission denied (EACCES)`. Let the app download on first use.
- **`HF_VIDEO_ENDPOINT_URL` must survive the deploy supervisor.** The backend
  start command (`scripts/staging-runtime.mjs`) used to delete
  `HF_VIDEO_ENDPOINT_URL` (a legacy guard) — that made every video call fail
  with `Invalid media URL`. It now strips only `VIDEO_API_URL` (the true legacy
  provider). If video breaks after a runtime change, check that line first.
- **Media tools are `allow` by default** (image/video); metering bounds cost.
  Users can re-gate them in Settings → Tools.
- **Long generations need the SSE keepalive** (`startKeepalive` in
  `agent/streaming.ts`) — without it the edge proxy idle-kills silent streams
  during multi-minute media calls.
- **Space-side fixes** (committed in `red-kit/nsfw-media-studio`): WAN
  `cross_attention_kwargs` → `attention_kwargs`; A100 fallback (int8
  dynamic-activation for the dual 14B transformers when FP8 + the sm120 AOTI
  artifact are unavailable); vendored RIFE `flownet` cast to cuda+half (its
  `device()` omits `.half()`); `/generate_video` returns a single Video
  (tuple returns crash Gradio's `video.py` postprocess); `/edit_image` shares
  the text-to-image pipe's components (no extra VRAM).
