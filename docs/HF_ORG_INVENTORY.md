# HF ORG INVENTORY (Stage 1)

Org: `redkits` (authenticated via the HF MCP session). Enumerated with `hf_fs ls` — commands executed.

## Models
| Repo | Verdict | Reasoning |
|---|---|---|
| `redkits/GLM-5.3-ABLITERATED-FP8` | Reuse (flagship alternative) | Org-owned unrestricted GLM-5.3 quantized fine-tune; old production ran glm53-ablit as large-context tier |
| `redkits/GLM-5.3-UNCENSORED-FP8` / `...-ABLITERATED-NVFP4` | Alternates | Same family, other precisions |
| `redkits/flux-h3-chain` (text-to-image, gated) | Investigate at GAP-004 build time | Likely the org's image pipeline base; else pin an uncensored FLUX.1-Kontext fine-tune |
| `redkits/whoami-probe-x` (private) | Ignore | Probe artifact |
| `redkits/headturn-liveness` (dataset) | Ignore | Not applicable to this build |

## Live Inference Endpoints (already deployed, E2E-verified this session)
| Endpoint | Model | Tier | Status |
|---|---|---|---|
| `y54ycbowmtsfq58i.us-east-1.aws.endpoints.huggingface.cloud` | `Qwen3.8-27B-Uncensored-Cyber` | Fast ("qwen 3.8 cyber" — exact spec) | Working ("WIRED") |
| `xwar8x002k4atwve.us-east-2.aws.endpoints.huggingface.cloud` | `s-zaizen/DeepSeek-V4.1-Flash-Abliterated` | Flagship ("deepseek v4.1 flash abl" — exact spec) | Working ("LARGE-WIRED") |

## Spaces
None — SearXNG Docker Space must be created in GAP-008 (execution phase).

## External provider endpoints needed (you provision, keys-last)
Image (unrestricted FLUX) · Video (unrestricted Wan2.x I2V) · Embeddings/reranker (bge-m3 family) · OCR/ASR/TTS · Brave/Tavily fallback keys · Stripe/email/OAuth.
