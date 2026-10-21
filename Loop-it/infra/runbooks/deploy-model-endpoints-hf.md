# Runbook: deploy the three model endpoints on Hugging Face

**Owner:** platform / inference
**Applies to:** P0-2 (provisioned inference endpoint), unblocks the Phase 1 exit gate
**Last verified:** 2026-09-05 (Router live policy); dedicated Endpoints hardware/prices last checked 2026-08-23

This runbook stands up the three model endpoints the router requires. Every fact below
(repo IDs, licenses, flags, prices) was verified against the Hugging Face model cards, the
official vLLM recipes, and the Inference Endpoints pricing page on the date above. Prices
and model rankings age quickly — re-verify before any commercial commitment.

---

## 0. Two paths, and which one you are on

There are two different Hugging Face products here, and conflating them is the most
expensive mistake available:

|                  | Inference **Router** (`router.huggingface.co`)           | Inference **Endpoints**             |
| ---------------- | -------------------------------------------------------- | ----------------------------------- |
| Shape            | Serverless, multi-provider, OpenAI-compatible            | Dedicated GPU you rent              |
| Billing          | Per token, provider pass-through, no HF markup           | Per hour, running or idle           |
| Weights run on   | A third party's hardware (deepinfra, together, novita…)  | Yours alone                         |
| Prompt retention | HF retains nothing; **each provider sets its own terms** | Your deployment                     |
| Good for         | Getting the loop working today                           | Production, once code is in prompts |

**Sections 1–9 below cover Endpoints.** This section covers the Router, which is what the
platform is wired to run against right now.

The two catalogues differ. `Qwen/Qwen3.8-27B-FP8` still has no Router provider
(`/v1/models/Qwen/Qwen3.8-27B-FP8` returns 404). The BF16 repo **is** served.
Live `huggingface_router_policy()` (verified 2026-09-05 against `GET /v1/models`):

| Class            | Preferred                                      | Fallback                         | Why this pin                                      |
| ---------------- | ---------------------------------------------- | -------------------------------- | ------------------------------------------------- |
| trivial          | `zai-org/GLM-5.3-Flash:baseten`                | `:fireworks-ai`                  | MIT; tools + json_schema                          |
| implementation   | `Qwen/Qwen3.8-27B:deepinfra`                   | `:ovhcloud`                      | Apache-2.0; tools + json_schema                   |
| planning         | `zai-org/GLM-5.3:baseten`                      | `:fireworks-ai`                  | tools + json_schema. **Not** `:deepinfra` (no JSON schema on GLM-5.3) |

Do not put `Qwen/Qwen3.8-27B-FP8` on the public Router policy. Dedicated Endpoints still use the FP8/NVFP4 checkpoints. GLM-5.3 is the **glm-5.3** license, not MIT. Compose default `huggingface-unrestricted` now targets the dedicated red-kit endpoints: Flash abl, Qwen3.8 uncensored, GLM-5.3 abl.

### Status: verified working end to end on 2026-08-23

`scripts/smoke_model_endpoint.py` drives the real `ModelRouter` — routing, server-side
credential injection, quota reservation, HTTP dispatch, token accounting, and audit — against
live models. All three difficulty classes answer, including under constrained decoding:

```
python scripts/smoke_model_endpoint.py --bill-to red-kit --structured --max-tokens 16384
```

The live policy is `huggingface_router_policy()` in `services/router-svc/src/loopit_router/routing.py`.

### "Omni" is not usable here — do not plan around it

HuggingChat's **Omni** is a _virtual model alias that exists only inside the chat-ui web app_.
It is synthesised server-side and, per chat-ui's own source, "never appears in `/v1/models`".
Verified directly:

```
POST /v1/chat/completions  {"model":"omni"}        -> 400 model_not_found
POST /v1/chat/completions  {"model":"router/omni"} -> 400 model_not_found
```

Blog posts claiming you can pass `"model": "omni"` to the Inference Router are wrong. Note
also that chat-ui's router stopped using a selection _model_ in May 2026 — it now picks a
route with a local heuristic (image → multimodal, tools → agentic, else default) and applies
a JSON policy of primary + fallback models.

That policy is structurally identical to `RoutingPolicy`, which is the useful conclusion:
**we already have Omni's design, and ours routes on task difficulty rather than modality,
which is the axis that actually drives cost here.** There is nothing to adopt, only to confirm.

### Provider pinning is a compliance control

Model ids carry an explicit `:provider` suffix (`Qwen/Qwen3.6-27B:deepinfra`). Unpinned, HF
selects a provider and may change it silently — which would change whose retention terms
govern a prompt containing customer source code, with no deploy and no audit trail. HF
retains nothing itself but **explicitly defers to each provider's policy**.

The pin is enforced remotely, not merely requested: a bogus provider returns
`400 "the provider or policy you attempted to specify … is not valid"`. Fallbacks stay on the
same weights and change only the provider, so an outage never silently swaps the model.

### Billing to an organisation

Set `X-HF-Bill-To` (`UpstreamEndpoint(bill_to=...)`). Two prerequisites, both learned the
hard way:

- **A classic token is refused** by an org with a token policy: `403 "your token needs to be
a fine-grained token"`. Create a fine-grained token with the org's
  _Make calls to Inference Providers_ permission.
- **The org needs credits.** A depleted account returns `402`, which the router treats as
  terminal — see below.

### Reasoning budget is the thing that will bite you

Every model in the live policy is a reasoning model. They emit the scratchpad to
`reasoning_content` and the answer to `content`. If the output budget runs out mid-thought
you get a **well-formed HTTP 200 with an empty answer** — which looks like success to every
layer above it.

Observed live, at `max_tokens=200`, asking Qwen3.5-9B to reply with one word:

```
content: ''   reasoning_content: 788 chars   finish_reason: length
```

`parse_result` now raises on content-free truncation instead of returning `""`. It is
classified _terminal_: at temperature 0 a retry buys the identical truncation at full price.

Measured floors, structured output enabled:

| Class          | Model       | Reasoning  | Output tokens | Verdict at 4096       |
| -------------- | ----------- | ---------- | ------------- | --------------------- |
| trivial        | Qwen3.5-9B  | 1.4k chars | 384           | fine                  |
| implementation | Qwen3.6-27B | 5.1k chars | 1,608         | **truncated at 4096** |
| planning       | GLM-5.2     | 2.7k chars | 664           | fine                  |

**Use at least 16384 output tokens for the coder class.** Note the cost shape: the coder
spent 1,608 output tokens to emit `s[::-1]`. Reasoning tokens, not answers, dominate spend —
so difficulty routing is worth more here than the per-token price differences.

### 402 and 503 mean opposite things

- **402 (no credits) is terminal.** Every candidate fails identically, so failing over adds
  latency and writes N audit rows blaming N models for one billing fault. Verified live: three
  difficulty classes produced exactly three audit events, not six.
- **503 (cold start) is transient** and retried against the _same_ model. A scale-to-zero
  endpoint answers 503 while it boots; treating that as a dead model would make the cheapest
  deployment mode look like the least reliable one.

### When to leave the Router

Move to dedicated Endpoints (sections 1–9) before customer source code goes into prompts at
volume. The Router's economics are better at low volume and its privacy posture is weaker,
because the terms that bind are the provider's, not Hugging Face's.

---

## 1. The three finalists

The router (`services/router-svc/src/loopit_router/routing.py`) defines three task classes.
Their placeholder names map to these repos:

| Class     | Repo                   | License    | Params           | Native ctx | Why this one                                                                         |
| --------- | ---------------------- | ---------- | ---------------- | ---------- | ------------------------------------------------------------------------------------ |
| `small`   | `Qwen/Qwen3.5-4B`      | Apache-2.0 | 4B dense         | 262,144    | Cheapest thing that can still classify difficulty and condense transcripts reliably. |
| `coder`   | `Qwen/Qwen3.8-27B-FP8` | Apache-2.0 | 27B dense        | 262,144    | The workhorse. Best agentic-coding score available under a clean permissive license. |
| `planner` | `zai-org/GLM-5.2-FP8`  | MIT        | ~743B / 39B act. | 1,048,576  | Frontier long-horizon reasoning, and the only frontier-class option that is MIT.     |

All three are **ungated** (`"gated": false`), so no terms acceptance is needed before pull.

### Why not the alternatives

- **Qwen3.6-27B** was the original pick. `Qwen3.8-27B` supersedes it: identical architecture,
  size and context, but Terminal-Bench 2.1 73.0 vs 63.4 and SWE-bench Pro 61.7 vs 53.5.
  Same Apache-2.0 license, so there is no reason to deploy the older one.
- **DeepSeek-V4-Pro-0813** (MIT) benchmarks higher than GLM-5.2 on Terminal Bench, but ships
  **no Jinja chat template** — it needs a custom encoding module. That breaks the drop-in
  OpenAI-compatible tool-calling path this platform depends on. Revisit when it has one.
- **Kimi-K3** is the strongest model here and the wrong choice. Its custom license requires a
  separate agreement with Moonshot AI for "Model as a Service" businesses over US$20M/12mo
  revenue — which is precisely what this platform is. I11 and P5-2 exist to keep that kind of
  term from being discovered after launch, not before.
- **`Qwen/Qwen3.6-4B` does not exist.** The Qwen3.6 line is 27B and 35B-A3B only, and there is
  no open-weight Qwen3.7 at all. Qwen3.8 shipped only 27B and 2.4T-A95B, and the 2.4T is
  `license:other`. The 4B small model therefore comes from the Qwen3.5 line.

### Cheaper planner while volume is low

A standing 8×H200 for the planner is **$40/hr — about $29,200/month if never idle**. Until
demand justifies that, deploy `zai-org/GLM-5.1-FP8` (MIT, same `glm47`/`glm45` parsers, drop-in)
or `Qwen/Qwen3.6-35B-A3B-FP8` (Apache-2.0, fits 1–2 mid GPUs) in the planner slot and promote
GLM-5.2 once the eval harness says the extra spend buys success rate.

---

## 2. Hardware and cost

Verified rates from the Inference Endpoints pricing page. Billing is **per minute**, and it
starts while the endpoint is _initializing_, not just running.

| Class     | Instance            | GPUs         | $/hr  | Notes                                                  |
| --------- | ------------------- | ------------ | ----- | ------------------------------------------------------ |
| `small`   | `aws / nvidia-a10g` | 1 × 24 GB    | $1.0  | ~8 GB BF16 weights, plenty of KV headroom              |
| `coder`   | `aws / nvidia-h200` | 1 × 141 GB   | $5.0  | ~28.6 GB FP8 weights; H200 gives full 262K KV headroom |
| `planner` | `aws / nvidia-h200` | 8 × 1,128 GB | $40.0 | ~743 GB FP8. Does **not** fit 8×H100 (640 GB). TP=8    |

`coder` also fits a single L40S-48GB ($1.8/hr) at reduced context. The vLLM recipe reports
14.28 GiB/GPU at TP2, so the weights fit easily — what does not fit is a 262K KV cache. Start
on H200 and only move down once you know your real context ceiling.

> **The single most expensive mistake here is a forgotten running endpoint** (risk R7). Enable
> scale-to-zero on all three before you walk away, and check the Quotas panel weekly.

---

## 3. Prerequisites

1. A Hugging Face account or org with an **active subscription and a card on file** — Inference
   Endpoints is not available without one.
2. GPU quota. The 8×H200 instance for the planner almost certainly needs a quota request; do
   this **first**, it is not instant. Check "Quotas Used" at https://ui.endpoints.huggingface.co.
3. A token with write access, and the CLI:

   ```bash
   pip install -U "huggingface_hub>=1.27.0"
   hf auth login
   ```

4. Decide the namespace now (personal vs org). Endpoints are namespaced and moving them later
   means recreating them.

---

## 4. Deploy

Each endpoint is created the same way: pick the repo, pick the instance, set the vLLM engine
flags via `--container-args`, and set `type protected` so the endpoint requires a token.

> **Never create these as `public`.** A public endpoint is an unauthenticated inference
> endpoint billed to you, and it is exactly the "forgotten open door" that I5 exists to
> prevent — the router is meant to be the only path to a model.

### 4.1 `small` — Qwen3.5-4B

Flags are card-verified from the Qwen3.5-4B model card. `--language-model-only` skips the
vision encoder, which this class never uses, and hands the freed memory to the KV cache.

```bash
hf endpoints deploy loopit-small \
  --repo Qwen/Qwen3.5-4B \
  --framework pytorch \
  --task text-generation \
  --accelerator gpu \
  --vendor aws --region us-east-1 \
  --instance-type nvidia-a10g --instance-size x1 \
  --type protected \
  --container-args "--max-model-len 65536 \
                    --tensor-parallel-size 1 \
                    --reasoning-parser qwen3 \
                    --enable-auto-tool-choice \
                    --tool-call-parser qwen3_coder \
                    --language-model-only"
```

65,536 rather than the native 262,144: this model classifies and summarises, and a KV cache
sized for a context it will never see is memory taken from throughput.

### 4.2 `coder` — Qwen3.8-27B-FP8

Flags from the official vLLM recipe (https://recipes.vllm.ai/Qwen/Qwen3.8-27B).

```bash
hf endpoints deploy loopit-coder \
  --repo Qwen/Qwen3.8-27B-FP8 \
  --framework pytorch \
  --task text-generation \
  --accelerator gpu \
  --vendor aws --region us-east-1 \
  --instance-type nvidia-h200 --instance-size x1 \
  --type protected \
  --container-args "--max-model-len 262144 \
                    --tensor-parallel-size 1 \
                    --kv-cache-dtype fp8 \
                    --reasoning-parser qwen3 \
                    --enable-auto-tool-choice \
                    --tool-call-parser qwen3_coder \
                    --speculative-config {\"method\":\"mtp\",\"num_speculative_tokens\":3}"
```

`--reasoning-parser qwen3` is **not optional**. The chat template opens every assistant turn
with `<think>`, so without the parser the entire reasoning trace lands in `message.content`
and the agent loop parses a tool call out of a monologue.

If you need more than 262K context, the card's Best Practices section gives the YaRN
`--hf-overrides` JSON plus `VLLM_ALLOW_LONG_MAX_MODEL_LEN=1`. Set the YaRN `factor` to your
real ceiling — static YaRN degrades short-context quality, and short contexts are the common
case.

### 4.3 `planner` — GLM-5.2-FP8

Flags from the official vLLM recipe (https://recipes.vllm.ai/zai-org/GLM-5.2).

```bash
hf endpoints deploy loopit-planner \
  --repo zai-org/GLM-5.2-FP8 \
  --framework pytorch \
  --task text-generation \
  --accelerator gpu \
  --vendor aws --region us-east-1 \
  --instance-type nvidia-h200 --instance-size x8 \
  --type protected \
  --container-args "--max-model-len 262144 \
                    --tensor-parallel-size 8 \
                    --kv-cache-dtype fp8 \
                    --reasoning-parser glm45 \
                    --enable-auto-tool-choice \
                    --tool-call-parser glm47"
```

Note the parser names do not match the model version — `glm47` and `glm45` are correct for
GLM-5.2 per the recipe. Do not "fix" them.

Running tool-calling **and** MTP speculative decoding at the same time requires vLLM `main`
rather than stable. Ship without MTP first; tool calling is load-bearing, MTP is an
optimisation.

### 4.4 Programmatic equivalent

If you prefer to keep this in code (recommended — it belongs in `infra/terraform` eventually):

```python
from huggingface_hub import create_inference_endpoint

endpoint = create_inference_endpoint(
    "loopit-coder",
    repository="Qwen/Qwen3.8-27B-FP8",
    framework="pytorch",
    task="text-generation",
    accelerator="gpu",
    vendor="aws",
    region="us-east-1",
    instance_type="nvidia-h200",
    instance_size="x1",
    type="protected",
    container_args=[...],
)
endpoint.wait()  # blocks until status == "running"
print(endpoint.url)
```

---

## 5. Enable scale-to-zero on all three

Do this immediately after each endpoint reaches `running`. In the endpoint's **Settings** tab,
or via `endpoint.update(...)`:

- **Min replicas: 0** (required for scale-to-zero), **max replicas** to your budget ceiling.
- Idle window: 1 hour by default. Shorten it for the planner, where an idle hour costs $40.

Understand the trade before enabling it. A scaled-to-zero endpoint **returns HTTP 503 while a
replica initialises**, and for a 743B model that cold start is minutes, not seconds. Two
consequences for this platform:

1. The router must treat 503 as "retry after scale-up", not as a model failure that burns an
   iteration from the run's budget.
2. Send `X-Scale-Up-Timeout: 600` on router requests so the proxy holds the connection until a
   replica is ready instead of failing fast.

A reasonable posture: `coder` keeps **min replicas 1** during working hours because it is on
the critical path of every run; `small` and `planner` scale to zero aggressively.

---

## 6. Wire the endpoints into the router

Endpoints are OpenAI-compatible. The base URL is the endpoint URL with `/v1` appended.

Store the endpoint URL and the HF token in Vault, never in the repo or in an env var baked
into an image (I2). The router reads them server-side; a sandbox must never see them (I5).

```
secrets://models/small    -> { base_url: "https://<...>.endpoints.huggingface.cloud/v1", api_key: "hf_***" }
secrets://models/coder    -> ...
secrets://models/planner  -> ...
```

Then update the routing policy with the real specs — `name`, `backend="vllm"`,
`credential_ref`, `license_id`, and the credit rates derived from §2. Note that
`default_policy()` in `routing.py` is a **development** policy; production routing is loaded
from configuration precisely so that swapping a model is a config change, not a deploy.

Smoke test each one before wiring it in:

```bash
curl "$ENDPOINT_URL/v1/chat/completions" \
  -H "Authorization: Bearer $HF_TOKEN" \
  -H "Content-Type: application/json" \
  -H "X-Scale-Up-Timeout: 600" \
  -d '{"model":"Qwen/Qwen3.8-27B-FP8",
       "messages":[{"role":"user","content":"Reply with the single word: ready"}],
       "max_tokens":16}'
```

Then verify tool calling specifically, since that is what the agent loop actually depends on
and it is the thing the parser flags exist to make work:

```bash
curl "$ENDPOINT_URL/v1/chat/completions" \
  -H "Authorization: Bearer $HF_TOKEN" -H "Content-Type: application/json" \
  -d '{"model":"Qwen/Qwen3.8-27B-FP8",
       "messages":[{"role":"user","content":"Read the file src/app.ts"}],
       "tools":[{"type":"function","function":{"name":"read_file",
         "parameters":{"type":"object","properties":{"path":{"type":"string"}},
                       "required":["path"]}}}],
       "tool_choice":"auto"}'
```

A response with `tool_calls` populated and an empty `content` means the parsers are right. A
response where the reasoning trace shows up in `content` means `--reasoning-parser` did not
take effect — fix that before running any eval, or every result will be noise.

---

## 7. Update the license register (P5-2, G-5)

No model serves commercially until its entry exists. `RoutingPolicy.licenses()` emits the
register from the live policy, so the `license_id` on each `ModelSpec` must be accurate:

| Model                  | `license_id` | Field-of-use restrictions            |
| ---------------------- | ------------ | ------------------------------------ |
| `Qwen/Qwen3.5-4B`      | `apache-2.0` | None beyond attribution/NOTICE       |
| `Qwen/Qwen3.8-27B-FP8` | `apache-2.0` | None beyond attribution/NOTICE       |
| `zai-org/GLM-5.2-FP8`  | `mit`        | None; card states no regional limits |

If you ever swap in a third-party quantisation (e.g. an NVFP4 community checkpoint), it is a
**separate artifact with its own license** and needs its own register row. The base model's
license does not automatically cover someone else's requantised weights.

---

## 8. Validate against the eval harness

Deployment is not done when the endpoints answer. It is done when the harness says the
routing is right. Per Doc 03 §5, promote a model into a class only if it wins on the four
KPIs — success rate, iteration count, cost per successful deploy, human-intervention rate —
never on public benchmark scores alone.

```bash
uv run python -m evals.harness --suite t0 --tier-gate
```

Optimise **cost per successful deploy, not cost per token**. A cheap model that needs nine
iterations loses to an expensive one that needs two, and only the harness can tell you which
you have.

---

## 9. Teardown

```bash
hf endpoints pause loopit-planner     # keeps config, stops billing
hf endpoints delete loopit-planner    # removes it entirely
hf endpoints ls --namespace '*'       # audit: find anything still running
```

Run the `ls` weekly. The failure mode is not dramatic — it is a $40/hr endpoint nobody
remembers creating, discovered on an invoice.

---

## Unverified / re-check before relying on

- **Minimum vLLM version for Qwen3.8-27B** is not stated on the model card or the recipe. Pin
  whatever version you validate against and record it here.
- **KV headroom for Qwen3.8-27B-FP8 on L40S-48GB and H100-80GB** is extrapolated from the
  recipe's TP2 measurement (14.28 GiB/GPU); the recipe does not show a run on either SKU.
- **DeepSeek-V4-Pro parameter counts** ("1.6T total / 49B active") could not be confirmed from
  the model card or config. Do not quote them.
- **Prices** are as of 2026-08-23 and change without notice.
