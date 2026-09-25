"""MiniMax-H3 conditioner service — port 8002.

Qwen3-VL 33B encodes the prompt (+ optional keyframes) into prompt_embeds /
text_token_tags, serialized to the denoiser as a single safetensors payload.

  POST /encode {prompt, image_b64?, last_image_b64?, height, width, num_frames}
  GET  /healthz
"""
import base64, io, os, tempfile, time, traceback

import torch
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from typing import Optional
from huggingface_hub import hf_hub_download

H3_MODEL_REPO = os.getenv("H3_MODEL_REPO", "MiniMaxAI/MiniMax-H3")
H3_FP8 = os.getenv("H3_FP8", "0") == "1"
VENDOR_SPACE = os.getenv("H3_VENDOR_SPACE", "observantdistressed/minimax-h3")
FPS = 24
cc = torch.cuda.get_device_capability(0)

print(f"[h3-cond] vendoring h3_split_blocks.py from {VENDOR_SPACE} ...", flush=True)
hf_hub_download(VENDOR_SPACE, "h3_split_blocks.py", repo_type="space", local_dir=".")

from h3_split_blocks import MiniMaxH3ConditionerBlocks  # noqa: E402

print(f"[h3-cond] loading conditioner from {H3_MODEL_REPO} (quantized={H3_FP8}, cc={cc}) ...", flush=True)
_started = time.time()
blocks = MiniMaxH3ConditionerBlocks()
pipe = blocks.init_pipeline(H3_MODEL_REPO)
pipe.load_components(dtype=torch.bfloat16)
if H3_FP8:
    from torchao.quantization import quantize_, Int8WeightOnlyConfig, Float8DynamicActivationFloat8WeightConfig
    cfg = Float8DynamicActivationFloat8WeightConfig() if cc >= (9, 0) else Int8WeightOnlyConfig()
    print(f"[h3-cond] quantizing text_encoder ({'fp8' if cc >= (9, 0) else 'int8'})", flush=True)
    quantize_(pipe.text_encoder, cfg)
pipe.to("cuda")
print(f"[h3-cond] ready in {time.time() - _started:.0f}s", flush=True)

MIN_FRAMES, MAX_FRAMES = 124, 345


def snap_frames(n):
    n = max(120, min(360, int(n)))
    k = -(-(n - 5) // 17)
    return min(MAX_FRAMES, 5 + 17 * k)


def _b64_to_pil(s):
    from PIL import Image, ImageOps
    return ImageOps.exif_transpose(Image.open(io.BytesIO(base64.b64decode(s)))).convert("RGB")


app = FastAPI(title="h3-conditioner", version="1.2")


class EncReq(BaseModel):
    prompt: str
    image_b64: Optional[str] = None
    last_image_b64: Optional[str] = None
    height: int = 544
    width: int = 960
    num_frames: int = 124


@app.get("/healthz")
def healthz():
    return {"ok": True, "quantized": H3_FP8, "cc": list(cc), "model": H3_MODEL_REPO}


@app.post("/encode")
def encode(req: EncReq):
    tmp = None
    try:
        image = _b64_to_pil(req.image_b64) if req.image_b64 else None
        last_image = _b64_to_pil(req.last_image_b64) if req.last_image_b64 else None
        num_frames = snap_frames(req.num_frames)
        t0 = time.time()
        state = pipe(prompt=req.prompt, image=image, last_image=last_image,
                     height=req.height, width=req.width)
        embeds = state.get("prompt_embeds").cpu()
        tags = state.get("text_token_tags").cpu()
        h, w = int(state.get("height")), int(state.get("width"))
        print(f"[h3-cond] {w}x{h} {num_frames}f (keyframes={image is not None}/{last_image is not None}) "
              f"in {time.time() - t0:.0f}s", flush=True)
        from safetensors.torch import save_file
        tmp = tempfile.NamedTemporaryFile(suffix=".safetensors", delete=False).name
        save_file({"prompt_embeds": embeds, "text_token_tags": tags}, tmp,
                  metadata={"height": str(h), "width": str(w), "num_frames": str(num_frames)})
        with open(tmp, "rb") as f:
            wire = base64.b64encode(f.read()).decode()
        return {"wire_b64": wire, "height": h, "width": w, "num_frames": num_frames}
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
    uvicorn.run(app, host="0.0.0.0", port=8002)
