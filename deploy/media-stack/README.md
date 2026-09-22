# NSFW Media Stack — loop-gpt sidecar

Three-model media generation stack for the Loop GPT backend:

| Model | Output | Hardware |
|---|---|---|
| Chroma1-HD 8.9B (uncensored) | Images | GPU 0 |
| WAN 2.2 I2V 14B Lightning (FP8, 50+ LoRAs) | Silent video @ 16fps | GPU 0 |
| MiniMax-H3 195.9 GiB (bf16, 93-LoRA catalog) | Video + synchronized audio @ 24fps | GPU 0 + GPU 1 |

## Railway deploy

Two services are deployed in the `loop-gpt` Railway project alongside the existing
`backend`, `web`, and `postgres` services:

1. **media-worker** (GPU): runs all three models on H200 hardware
2. **media-gateway** (CPU): FastAPI auth/rate-limit gateway, talks ONLY to media-worker

## How the backend connects

The backend talks to the media-gateway on port 8000 via Railway private networking:

- `IMAGE_API_URL=http://media-gateway.railway.internal:8000` (image generation proxied to Chroma1-HD)
- `HF_VIDEO_ENDPOINT=http://media-gateway.railway.internal:8000/generate_video` (video via WAN/H3)
- Videos are returned as base64 in JSON, same as HF Spaces

The gateway at port 8000 exposes:
- `POST /generate_image` → Chroma1-HD
- `POST /generate_video` → WAN 2.2 I2V (image-to-video)
- `POST /image_to_video` → chained Chroma → WAN
- `POST /generate_premium_video` → MiniMax-H3 (audio + video)
- `GET /loras` → H3 NSFW LoRA catalog
- `GET /healthz` → aggregate health
