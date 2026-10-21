# ADR-0006: vLLM as the serving engine; never TGI

- **Status:** Accepted
- **Date:** 2026-08-23
- **Deciders:** Founding engineering
- **Handbook refs:** `docs/03-model-layer-and-serving.md` §1
- **Invariants touched:** I5

## Context

Our workload has a long, stable system prompt shared across nearly every request, heavy concurrency, and a hard requirement for valid JSON tool calls and task DAGs. Text Generation Inference entered maintenance mode on 2025-12-11 and Hugging Face itself now recommends vLLM or SGLang.

## Decision

We will serve open-weight models with vLLM behind an OpenAI-compatible API, relying on PagedAttention for throughput, automatic prefix caching for the shared harness prefix, and structured outputs for tool calls. SGLang is a supported alternate backend behind the same API. We will not build on TGI.

## Alternatives considered

| Option | Pros | Cons | Why not chosen |
|---|---|---|---|
| TGI | Familiar, HF-native | In maintenance mode since 2025-12-11; HF recommends against it | Dead end |
| SGLang | RadixAttention scheduling for shared-prefix multi-turn traffic | Smaller ecosystem | Kept as a first-class alternate, selectable by config |
| Managed proprietary APIs only | Zero ops | Defeats the product thesis of open model choice | Contradicts the product |

## Consequences

**Positive:** High throughput; prompt-token costs cut by the prefix cache; tool calls validate by construction.

**Negative / accepted costs:** We own vLLM upgrades and GPU operations from Phase 4 onward.

## Revisit trigger

Re-verify the vLLM vs SGLang recommendation and TGI status quarterly; vendor facts here were verified 2026-08-17.
