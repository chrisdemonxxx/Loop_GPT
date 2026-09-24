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

### Verified

- Space `/edit_image` on a copper-red-haired, green-eyed, freckled portrait →
  same identity (vision: `SAME_PERSON=YES`) with the prompt applied.
- App-level attach + "make her NSFW" → image artifact, same identity.
- App-level reference video with `lock_strength=0.6` → mp4 whose **first
  frame** is the same woman.

## Operational notes

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
