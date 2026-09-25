"""Public API gateway — port 8000 (v2). The single entry point your web app talks to.

  POST /generate_image           fast image (Chroma1-HD)                    -> media:8001
  POST /generate_video           fast I2V (WAN 2.2 Lightning)               -> media:8001
  POST /image_to_video           chained image -> video                     -> media:8001
  POST /generate_premium_video   H3 video + synchronized audio              -> conditioner:8002 -> denoiser:8003
                                  (turbo mode + NSFW LoRA catalog supported)
  GET  /loras                    H3 NSFW LoRA catalog (key/label/scale/trigger)
  GET  /healthz                  aggregate service health

All media is base64 in JSON. For production, put this behind your auth/rate-limit layer.
"""
import os, sys
import requests
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from typing import List, Optional
from huggingface_hub import hf_hub_download

MEDIA_URL = os.getenv("MEDIA_URL", "http://localhost:8001")
H3_CONDITIONER_URL = os.getenv("H3_CONDITIONER_URL", "http://localhost:8002")
H3_DENOISER_URL = os.getenv("H3_DENOISER_URL", "http://localhost:8003")
VENDOR_SPACE = os.getenv("H3_VENDOR_SPACE", "observantdistressed/minimax-h3")

CANVASES = {
    "960x544 · 16:9 fast": (544, 960), "1024x576 · 16:9 fast": (576, 1024),
    "1152x640 · 16:9": (640, 1152), "1280x704 · 16:9": (704, 1280),
    "1344x768 · 16:9 full": (768, 1344),
    "544x960 · 9:16 fast": (960, 544), "640x1152 · 9:16": (1152, 640),
    "768x1344 · 9:16 full": (1344, 768),
    "544x544 · 1:1 fast": (544, 544), "768x768 · 1:1 full": (768, 768),
    "1024x1024 · 1:1 max": (1024, 1024),
    "768x576 · 4:3 fast": (576, 768), "1024x768 · 4:3 full": (768, 1024),
    "576x768 · 3:4 fast": (768, 576), "768x1024 · 3:4 full": (1024, 768),
    "1152x512 · 21:9 fast": (512, 1152), "1536x672 · 21:9 full": (672, 1536),
}

try:
    hf_hub_download(VENDOR_SPACE, "config.py", repo_type="space", local_dir="/tmp/h3_vendor")
    sys.path.insert(0, "/tmp/h3_vendor")
    from config import NSFW_LORA_CONFIGS
except Exception as _e:
    print(f"[gateway] H3 LoRA catalog unavailable: {_e}", flush=True)
    NSFW_LORA_CONFIGS = {}

app = FastAPI(title="nsfw-media-stack gateway", version="2.1")


def _post(url, payload, timeout=900):
    r = requests.post(url, json=payload, timeout=timeout)
    if r.status_code != 200:
        raise HTTPException(r.status_code, f"upstream {url}: {r.text[:2000]}")
    return r.json()


class ImageReq(BaseModel):
    prompt: str
    negative_prompt: str = ""
    width: int = 1024
    height: int = 1024
    steps: int = 28
    guidance_scale: float = 3.5
    seed: int = -1


class VideoReq(BaseModel):
    image_b64: str
    last_image_b64: Optional[str] = None
    prompt: str = ""
    steps: int = 4
    duration_seconds: float = 3.0
    guidance_scale: float = 1.0
    guidance_scale_2: float = 1.0
    seed: int = -1
    scheduler: str = "UniPCMultistep"
    flow_shift: float = 6.0
    frame_multiplier: int = 16
    quality: int = 5
    auto_lora: bool = True
    lora_groups: Optional[List[str]] = None


class I2VReq(BaseModel):
    image_prompt: str
    video_prompt: str = ""
    width: int = 832
    height: int = 480
    img_steps: int = 28
    img_guidance: float = 3.5
    vid_steps: int = 4
    duration_seconds: float = 3.0
    frame_multiplier: int = 16
    auto_lora: bool = True
    seed: int = -1


class PremiumReq(BaseModel):
    prompt: str
    image_b64: Optional[str] = None
    last_image_b64: Optional[str] = None
    canvas: str = "960x544 · 16:9 fast"
    duration_seconds: float = 5.0
    steps: int = 25
    seed: int = -1
    turbo: bool = False
    nsfw_loras: List[str] = []
    nsfw_scales: dict = {}


@app.get("/healthz")
def healthz():
    out = {}
    for name, url in (("media", MEDIA_URL), ("conditioner", H3_CONDITIONER_URL), ("denoiser", H3_DENOISER_URL)):
        try:
            out[name] = requests.get(f"{url}/healthz", timeout=5).json()
        except Exception as e:
            out[name] = {"ok": False, "error": str(e)[:200]}
    return out


@app.get("/loras")
def loras():
    return [{"key": k, "label": v.get("label", k), "scale": v.get("scale", 1.0),
             "trigger": v.get("trigger", "")} for k, v in NSFW_LORA_CONFIGS.items()]


@app.post("/generate_image")
def generate_image(req: ImageReq):
    return _post(f"{MEDIA_URL}/generate_image", req.model_dump())


@app.post("/generate_video")
def generate_video(req: VideoReq):
    return _post(f"{MEDIA_URL}/generate_video", req.model_dump())


@app.post("/image_to_video")
def image_to_video(req: I2VReq):
    return _post(f"{MEDIA_URL}/image_to_video", req.model_dump())


@app.post("/generate_premium_video")
def generate_premium_video(req: PremiumReq):
    if req.canvas not in CANVASES:
        raise HTTPException(400, f"unknown canvas; pick one of: {list(CANVASES)}")
    h, w = CANVASES[req.canvas]
    duration = max(5.0, min(15.0, float(req.duration_seconds)))
    prompt = req.prompt
    keys = [k for k in req.nsfw_loras if k in NSFW_LORA_CONFIGS]
    for k in keys:
        trig = NSFW_LORA_CONFIGS[k].get("trigger")
        if trig:
            prompt = f"{prompt}, {trig}"
    if keys and "nsfw_aio" in NSFW_LORA_CONFIGS and "nsfw_aio" not in keys:
        keys.append("nsfw_aio")
    enc = _post(f"{H3_CONDITIONER_URL}/encode", {
        "prompt": prompt, "image_b64": req.image_b64, "last_image_b64": req.last_image_b64,
        "height": h, "width": w, "num_frames": round(duration * 24),
    })
    result = _post(f"{H3_DENOISER_URL}/generate", {
        "wire_b64": enc["wire_b64"], "steps": req.steps, "seed": req.seed,
        "image_b64": req.image_b64, "last_image_b64": req.last_image_b64,
        "turbo": req.turbo, "nsfw_loras": keys, "nsfw_scales": req.nsfw_scales,
    })
    result["canvas"] = f"{enc['width']}x{enc['height']}"
    return result


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
