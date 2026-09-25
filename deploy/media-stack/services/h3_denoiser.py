"""MiniMax-H3 denoiser service — port 8003 (v2.1).

Consumes conditioner wire payloads, runs the 50-block joint audio+video DiT,
decodes both VAEs, muxes with the native diffusers encode_video audio path.

  POST /generate {wire_b64, steps, seed, turbo?, nsfw_loras?, nsfw_scales?,
                  image_b64?, last_image_b64?}
  GET  /loras    the NSFW LoRA catalog (key/label/scale/trigger)
  GET  /healthz
"""
import base64, io, os, sys, tempfile, threading, time, traceback

import torch
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from typing import Dict, List, Optional
from huggingface_hub import hf_hub_download

H3_MODEL_REPO = os.getenv("H3_MODEL_REPO", "MiniMaxAI/MiniMax-H3")
H3_FP8 = os.getenv("H3_FP8", "0") == "1"
H3_COMPILE = os.getenv("H3_COMPILE", "0") == "1"
VENDOR_SPACE = os.getenv("H3_VENDOR_SPACE", "observantdistressed/minimax-h3")
FPS = 24
cc = torch.cuda.get_device_capability(0)

# ---- vendor the reference H3 machinery verbatim ----
print(f"[h3-denoiser] vendoring from {VENDOR_SPACE} ...", flush=True)
for path in ("h3_split_blocks.py", "config.py", "fetch.py", "lora_utils.py", "state.py",
             "lora/__init__.py", "lora/custom.py", "lora/format.py",
             "lora/manager.py", "lora/sources/__init__.py", "lora/sources/civitai.py"):
    hf_hub_download(VENDOR_SPACE, path, repo_type="space", local_dir=".")
import config as h3cfg
from h3_split_blocks import MiniMaxH3GeneratorBlocks  # noqa: E402
from fetch import _apply_turbo, _apply_nsfw, _ensure_nsfw_lora_loaded  # noqa: E402
from state import LAST_TURBO_STATE, LAST_NSFW_STATE  # noqa: E402

print(f"[h3-denoiser] loading from {H3_MODEL_REPO} (quantized={H3_FP8}, cc={cc}) ...", flush=True)
_started = time.time()
blocks = MiniMaxH3GeneratorBlocks()
gen_pipe = blocks.init_pipeline(H3_MODEL_REPO)
gen_pipe.load_components(dtype=torch.bfloat16)
if H3_FP8:
    from torchao.quantization import quantize_, Int8WeightOnlyConfig, Float8DynamicActivationFloat8WeightConfig
    cfg = Float8DynamicActivationFloat8WeightConfig() if cc >= (9, 0) else Int8WeightOnlyConfig()
    print(f"[h3-denoiser] quantizing transformer ({'fp8' if cc >= (9, 0) else 'int8'})", flush=True)
    quantize_(gen_pipe.transformer, cfg)
gen_pipe.to("cuda")
if H3_COMPILE and not H3_FP8:
    print("[h3-denoiser] torch.compile (bf16 path)", flush=True)
    gen_pipe.transformer = torch.compile(gen_pipe.transformer)
elif H3_COMPILE and H3_FP8:
    print("[h3-denoiser] skipping torch.compile on quantized (eager)", flush=True)
print(f"[h3-denoiser] ready in {time.time() - _started:.0f}s "
      f"(peak {torch.cuda.max_memory_allocated() / 2**30:.1f} GiB)", flush=True)

_MODEL_LOCK = threading.Lock()

app = FastAPI(title="h3-denoiser", version="2.1")


class GenReq(BaseModel):
    wire_b64: str
    steps: int = 25
    seed: int = -1
    image_b64: Optional[str] = None
    last_image_b64: Optional[str] = None
    turbo: bool = False
    nsfw_loras: List[str] = []
    nsfw_scales: Dict[str, float] = {}


@app.get("/healthz")
def healthz():
    return {"ok": True, "quantized": H3_FP8, "cc": list(cc), "compile": H3_COMPILE and not H3_FP8,
            "nsfw_catalog": len(h3cfg.NSFW_LORA_CONFIGS), "model": H3_MODEL_REPO}


@app.get("/loras")
def loras():
    return [{"key": k, "label": v.get("label", k), "scale": v.get("scale", 1.0),
             "trigger": v.get("trigger", "")} for k, v in h3cfg.NSFW_LORA_CONFIGS.items()]


def _b64_to_pil(s):
    from PIL import Image, ImageOps
    return ImageOps.exif_transpose(Image.open(io.BytesIO(base64.b64decode(s)))).convert("RGB")


@app.post("/generate")
def generate(req: GenReq):
    tmp = None
    try:
        raw = base64.b64decode(req.wire_b64)
        tmp = tempfile.NamedTemporaryFile(suffix=".safetensors", delete=False).name
        with open(tmp, "wb") as f:
            f.write(raw)
        from safetensors.torch import load_file
        from safetensors import safe_open
        tensors = load_file(tmp)
        with safe_open(tmp, framework="pt") as f:
            meta = f.metadata() or {}
        h = int(meta.get("height", 544)); w = int(meta.get("width", 960))
        num_frames = int(meta.get("num_frames", 124))

        with _MODEL_LOCK:
            applied = []
            turbo_on = False
            try:
                if req.turbo:
                    _apply_turbo(gen_pipe, True)
                    turbo_on = True
                for key in req.nsfw_loras:
                    if key not in h3cfg.NSFW_LORA_CONFIGS:
                        continue
                    _ensure_nsfw_lora_loaded(gen_pipe, key)
                    scale = float(req.nsfw_scales.get(key) or h3cfg.NSFW_LORA_CONFIGS[key].get("scale", 1.0))
                    _apply_nsfw(gen_pipe, key, scale)
                    applied.append(key)
                steps = 7 if turbo_on else req.steps
                kwargs = dict(
                    prompt_embeds=tensors["prompt_embeds"].to("cuda"),
                    text_token_tags=tensors["text_token_tags"],
                    image=_b64_to_pil(req.image_b64) if req.image_b64 else None,
                    last_image=_b64_to_pil(req.last_image_b64) if req.last_image_b64 else None,
                    height=h, width=w, num_frames=num_frames, num_inference_steps=steps,
                )
                gen = torch.Generator("cpu").manual_seed(req.seed) if req.seed >= 0 else None
                t0 = time.time()
                try:
                    state = gen_pipe(**kwargs, generator=gen) if gen is not None else gen_pipe(**kwargs)
                except TypeError:
                    state = gen_pipe(**kwargs)
                print(f"[h3-denoiser] {num_frames}f {w}x{h} {steps}-step turbo={turbo_on} "
                      f"loras={applied} in {time.time() - t0:.0f}s", flush=True)
            finally:
                for key in applied:
                    try:
                        _apply_nsfw(gen_pipe, key, 0.0)
                    except Exception:
                        pass
                LAST_NSFW_STATE.update({k: None for k in applied})
                if turbo_on:
                    try:
                        _apply_turbo(gen_pipe, False)
                    except Exception:
                        pass
                LAST_TURBO_STATE.update({"path": None, "scale": None})

        videos = state.get("videos")
        audio = state.get("audio")
        sampling_rate = state.get("sampling_rate")
        frames = videos[0]
        if hasattr(frames, "detach"):
            frames = frames.detach().float().cpu().numpy()
        from diffusers.utils import encode_video
        out_tmp = tempfile.NamedTemporaryFile(suffix=".mp4", delete=False).name
        encode_video(frames, fps=FPS, output_path=out_tmp,
                     audio=audio[0].cpu() if audio is not None else None,
                     audio_sample_rate=int(sampling_rate) if sampling_rate else None)
        with open(out_tmp, "rb") as f:
            video_b64 = base64.b64encode(f.read()).decode()
        os.remove(out_tmp)
        return {"video_b64": video_b64, "fps": FPS, "frames": num_frames,
                "has_audio": audio is not None, "turbo": req.turbo, "loras": req.nsfw_loras,
                "seed": req.seed}
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(500, f"{type(e).__name__}: {e}")
    finally:
        if tmp:
            try:
                os.remove(tmp)
            except OSError:
                pass


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8003)
