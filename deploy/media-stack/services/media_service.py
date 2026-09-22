"""Media service — port 8001. Image (Chroma1-HD) + fast video (WAN 2.2 I2V Lightning).

  POST /generate_image   text -> image
  POST /generate_video   image (+ optional last frame) -> video (fp16 RIFE interpolation optional)
  POST /image_to_video   prompt -> Chroma image -> WAN video
  GET  /healthz
"""
import base64, io, os, tempfile, time, traceback

import numpy as np
import torch
import torch._dynamo
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from typing import List, Optional
from PIL import Image, ImageOps
from huggingface_hub import hf_hub_download

from diffusers import ChromaPipeline, UniPCMultistepScheduler, FlowMatchEulerDiscreteScheduler
from diffusers.pipelines.wan.pipeline_wan_i2v import WanImageToVideoPipeline
from diffusers.utils.export_utils import export_to_video
from torchao.quantization import quantize_, Int8WeightOnlyConfig, Float8DynamicActivationFloat8WeightConfig

WAN_REPO = os.getenv("WAN_MODEL_REPO", "thornmaze/WAMU_v3_WAN2.2_I2V_LIGHTNING")
CHROMA_REPO = os.getenv("IMAGE_MODEL_REPO", "lodestones/Chroma1-HD")
AOTI_REPO = os.getenv("AOTI_ARTIFACT_REPO", "thornmaze/WanTransformer3DModel-sm120-cu130-raa")
AOTI_MODE = os.getenv("AOTI_MODE", "eager")
CHROMA_BF16 = os.getenv("CHROMA_BF16", "0") == "1"
VENDOR_SPACE = os.getenv("WAN_VENDOR_SPACE", "observantdistressed/wan2-2-i2v-v3")
AOTI_FILENAME = "compiled-transformer-wan-i2v-14b.zip"

cc = torch.cuda.get_device_capability(0)
FP8_OK = cc >= (9, 0)
print(f"[media] gpu cc={cc} fp8={FP8_OK} aoti={AOTI_MODE} chroma_bf16={CHROMA_BF16}", flush=True)

# ---- vendor the reference LoRA loader + RIFE interpolation ----
print(f"[media] vendoring lora_loader.py + RIFE from {VENDOR_SPACE} ...", flush=True)
hf_hub_download(VENDOR_SPACE, "lora_loader.py", repo_type="space", local_dir=".")
rife_dir = tempfile.mkdtemp(prefix="rife_")
for name in ("IFNet_HDv4.py", "IFNet.py", "warplayer.py", "loss.py", "laplacian.py",
             "refine.py", "RIFE_HDv3.py", "IFBlock.py", "head.py"):
    hf_hub_download(VENDOR_SPACE, f"rife4226/{name}", repo_type="space", local_dir=rife_dir)
hf_hub_download(VENDOR_SPACE, "rife4226/flownet.pkl", repo_type="space", local_dir=rife_dir)

import lora_loader  # noqa: E402
sys_path_rife = os.path.join(rife_dir, "rife4226")
import sys
sys.path.insert(0, sys_path_rife)
from rife4226.IFNet_HDv4 import IFNet  # noqa: E402

# ---------------- WAN 2.2 I2V 14B Lightning ----------------
print(f"[media] loading WAN from {WAN_REPO} ...", flush=True)
_started = time.time()
pipe = WanImageToVideoPipeline.from_pretrained(WAN_REPO, torch_dtype=torch.bfloat16)
quantize_(pipe.text_encoder, Int8WeightOnlyConfig()); torch._dynamo.reset()
if FP8_OK:
    quantize_(pipe.transformer, Float8DynamicActivationFloat8WeightConfig()); torch._dynamo.reset()
    quantize_(pipe.transformer_2, Float8DynamicActivationFloat8WeightConfig()); torch._dynamo.reset()
else:
    print("[media] cc<9.0 — int8 fallback", flush=True)
    quantize_(pipe.transformer, Int8WeightOnlyConfig()); torch._dynamo.reset()
    quantize_(pipe.transformer_2, Int8WeightOnlyConfig()); torch._dynamo.reset()
pipe.to("cuda")

if AOTI_MODE == "artifact" and cc == (12, 0):
    import spaces
    artifact = hf_hub_download(AOTI_REPO, AOTI_FILENAME)
    spaces.aoti_load(pipe.transformer, artifact)
    spaces.aoti_load(pipe.transformer_2, artifact)
    spaces.aoti_apply(pipe.transformer, artifact)
    spaces.aoti_apply(pipe.transformer_2, artifact)
    print(f"[media] AoTI artifact applied", flush=True)
elif AOTI_MODE == "compile":
    print("[media] torch.compile on quantized WAN — slow warmup", flush=True)
    pipe.transformer = torch.compile(pipe.transformer)
    pipe.transformer_2 = torch.compile(pipe.transformer_2)
else:
    print("[media] WAN running eager (quantized)", flush=True)
print(f"[media] WAN ready in {time.time() - _started:.0f}s", flush=True)

# ---------------- Chroma1-HD image model ----------------
print(f"[media] loading Chroma from {CHROMA_REPO} ...", flush=True)
_started = time.time()
img_pipe = ChromaPipeline.from_pretrained(CHROMA_REPO, torch_dtype=torch.bfloat16)
quantize_(img_pipe.text_encoder, Int8WeightOnlyConfig()); torch._dynamo.reset()
if CHROMA_BF16:
    img_pipe.to("cuda")
    img_pipe.transformer = torch.compile(img_pipe.transformer)
elif FP8_OK:
    quantize_(img_pipe.transformer, Float8DynamicActivationFloat8WeightConfig()); torch._dynamo.reset()
    img_pipe.to("cuda")
else:
    quantize_(img_pipe.transformer, Int8WeightOnlyConfig()); torch._dynamo.reset()
    img_pipe.to("cuda")
print(f"[media] Chroma ready in {time.time() - _started:.0f}s", flush=True)

# ---------------- RIFE ----------------
rife_model = None
def get_rife():
    global rife_model
    if rife_model is None:
        m = IFNet()
        m.load_state_dict(torch.load(os.path.join(sys_path_rife, "flownet.pkl"), map_location="cpu"))
        m.eval().to("cuda", dtype=torch.float16)
        rife_model = m
    return rife_model


@torch.no_grad()
def interpolate(frames, multiplier=16):
    if multiplier <= 1:
        return frames
    import cv2
    rife = get_rife()
    frames = [np.asarray(f, dtype=np.uint8) for f in frames]
    target = min(128, max(17, int(round((len(frames) - 1) * multiplier + 1))))
    out = [frames[0]]
    for i in range(len(frames) - 1):
        n = max(2, int(round((target - 1) / (len(frames) - 1))) + 1)
        f0 = torch.from_numpy(frames[i].transpose(2, 0, 1)).unsqueeze(0).cuda().half() / 255.0
        f1 = torch.from_numpy(frames[i + 1].transpose(2, 0, 1)).unsqueeze(0).cuda().half() / 255.0
        _, ph, pw = f0.shape[1], f0.shape[2], f0.shape[3]
        pad_h, pad_w = (64 - ph % 64) % 64, (64 - pw % 64) % 64
        if pad_h or pad_w:
            f0 = torch.nn.functional.pad(f0, (0, pad_w, 0, pad_h), mode="replicate")
            f1 = torch.nn.functional.pad(f1, (0, pad_w, 0, pad_h), mode="replicate")
        for j in range(1, n):
            t = j / n
            mid, _, _ = rife(torch.cat([f0, f1], dim=1), timestep=t, scale_list=[4, 2, 1])
            out.append((mid[0, :, :ph, :pw].clamp(0, 1) * 255).byte().permute(1, 2, 0).cpu().numpy())
        out.append(frames[i + 1])
    return out[:target]


def _b64_to_pil(s):
    return ImageOps.exif_transpose(Image.open(io.BytesIO(base64.b64decode(s)))).convert("RGB")


def _pil_to_b64(img):
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode()


def _video_b64(frames, fps, quality):
    tmp = tempfile.NamedTemporaryFile(suffix=".mp4", delete=False).name
    export_to_video(frames, tmp, fps=fps, quality=quality)
    with open(tmp, "rb") as f:
        data = base64.b64encode(f.read()).decode()
    os.remove(tmp)
    return data


app = FastAPI(title="media-service", version="2.1")
WAN_MAX_DIM, WAN_MAX_FRAMES = 832, 321


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


@app.get("/healthz")
def healthz():
    return {"ok": True, "fp8": FP8_OK, "cc": list(cc), "aoti_mode": AOTI_MODE,
            "chroma_bf16": CHROMA_BF16}


@app.post("/generate_image")
def generate_image(req: ImageReq):
    try:
        t0 = time.time()
        gen = torch.Generator("cuda").manual_seed(req.seed) if req.seed >= 0 else None
        out = img_pipe(prompt=req.prompt, negative_prompt=req.negative_prompt or None,
                       width=req.width, height=req.height,
                       num_inference_steps=req.steps, guidance_scale=req.guidance_scale,
                       generator=gen)
        seed_used = req.seed if req.seed >= 0 else -1
        return {"image_b64": _pil_to_b64(out.images[0]), "seed": seed_used,
                "elapsed_s": round(time.time() - t0, 1)}
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(500, f"{type(e).__name__}: {e}")


def _run_video(req: VideoReq, image: Image.Image):
    t0 = time.time()
    max_side = max(image.size)
    if max_side > WAN_MAX_DIM:
        s = WAN_MAX_DIM / max_side
        image = image.resize((max(16, round(image.size[0] * s / 16) * 16),
                              max(16, round(image.size[1] * s / 16) * 16)))
    w, h = image.size
    num_frames = max(17, min(WAN_MAX_FRAMES, round(req.duration_seconds * 16) // 4 * 4 + 1))
    if req.scheduler == "UniPCMultistep":
        cfg = dict(pipe.scheduler.config); cfg["flow_shift"] = req.flow_shift
        pipe.scheduler = UniPCMultistepScheduler.from_config(cfg)
    else:
        cfg = dict(pipe.scheduler.config); cfg["shift"] = req.flow_shift
        pipe.scheduler = FlowMatchEulerDiscreteScheduler.from_config(cfg)

    lora_kwargs = {}
    active = []
    if req.lora_groups:
        names = [n for g in req.lora_groups
                 for n in lora_loader.get_group_lora_names(g, loras_only=True)]
        if names:
            active = lora_loader.load_loras(pipe, names)
            lora_kwargs = lora_loader.build_lora_kwargs(active)
    gen = torch.Generator("cuda").manual_seed(req.seed) if req.seed >= 0 else None
    out = pipe(image=image, prompt=req.prompt or "", height=h, width=w,
               num_frames=num_frames, num_inference_steps=req.steps,
               guidance_scale=req.guidance_scale, guidance_scale_2=req.guidance_scale_2,
               generator=gen, output_type="np",
               cross_attention_kwargs=lora_kwargs or None)
    if active:
        lora_loader.unload_loras(pipe, active)
    frames = [Image.fromarray((np.clip(f, 0, 1) * 255).astype(np.uint8))
              for f in out.frames[0]] if out.frames[0].max() <= 1.01 else \
             [Image.fromarray(f.astype(np.uint8)) for f in out.frames[0]]
    native_fps, fps = 16, 16
    if req.frame_multiplier > 1:
        frames = interpolate(frames, req.frame_multiplier)
        fps = native_fps * req.frame_multiplier
    return {"video_b64": _video_b64(frames, fps, req.quality), "fps": fps,
            "frames": len(frames), "elapsed_s": round(time.time() - t0, 1)}


@app.post("/generate_video")
def generate_video(req: VideoReq):
    try:
        return _run_video(req, _b64_to_pil(req.image_b64))
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(500, f"{type(e).__name__}: {e}")


@app.post("/image_to_video")
def image_to_video(req: I2VReq):
    try:
        t0 = time.time()
        gen = torch.Generator("cuda").manual_seed(req.seed) if req.seed >= 0 else None
        img = img_pipe(prompt=req.image_prompt, width=req.width, height=req.height,
                       num_inference_steps=req.img_steps, guidance_scale=req.img_guidance,
                       generator=gen).images[0]
        result = _run_video(VideoReq(image_b64=_pil_to_b64(img), prompt=req.video_prompt,
                                     steps=req.vid_steps, duration_seconds=req.duration_seconds,
                                     frame_multiplier=req.frame_multiplier,
                                     auto_lora=req.auto_lora, seed=req.seed), img)
        result["image_b64"] = _pil_to_b64(img)
        result["elapsed_s"] = round(time.time() - t0, 1)
        return result
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(500, f"{type(e).__name__}: {e}")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8001)
