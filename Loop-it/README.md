# Loop-it

An open, self-hosted, **model-unrestricted** AI software-building platform: a Replit/Lovable-class
agentic app builder running on open-weight models, where users own their code.

> **"Unrestricted" means three things: open model choice, code ownership, and capability breadth.**
> It never means removing sandbox isolation, tenant separation, egress control, or abuse detection.
> An uncensored _model layer_ sits on top of a hardened _execution layer_. They are orthogonal.

## The cardinal rule

**Agent-generated code executes only in the data plane, never in the control plane.**

Ask this on every design review and every PR: _"Where does this code run, and is that the data plane?"_

## Repository map

| Path               | Owns                                                                                                                                                                                               |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/`            | The handbook — architecture (`01`), sandbox (`02`), models (`03`), orchestration (`04`), verification (`05`), control plane (`06`), ops (`07`), security (`08`), roadmap (`09`), governance (`10`) |
| `docs/adr/`        | Architecture Decision Records — one per locked decision                                                                                                                                            |
| `PLAN.md`          | The end-to-end build plan: invariants, stack, Phases 0–5, gates                                                                                                                                    |
| `apps/`            | `web` (UI), `api` (control-plane gateway), `admin` (ops console)                                                                                                                                   |
| `services/`        | Control-plane services: orchestrator, router-svc, scheduler, preview-proxy, egress-proxy, billing, abuse-engine; `services/secrets-broker` is the in-process broker library used by trusted services |
| `packages/`        | Shared libs: agent-core, tools, patch, sandbox-sdk, contracts, policy, ui-kit                                                                                                                      |
| `sandbox/`         | Data-plane substrate: microVM image, in-VM agent runtime, network policy                                                                                                                           |
| `stack-templates/` | The **one** opinionated generated-app stack                                                                                                                                                        |
| `evals/`           | Eval harness, task tiers T0–T3, red-team suites                                                                                                                                                    |
| `infra/`           | Terraform, Helm, runbooks                                                                                                                                                                          |

## Invariants

Twelve invariants (I1–I12) are defined in [`PLAN.md`](./PLAN.md) §0 and are non-negotiable. The most
load-bearing:

- **I1** Generated code runs only in the data plane.
- **I2** No ambient credentials in any sandbox.
- **I3** Default-deny egress, category allowlist through a logging proxy.
- **I4** Cloud metadata endpoint blocked, fail-closed, red-team verified.
- **I5** The model router is the only sandbox→model path.
- **I6** Diff/patch edits only — never full-file rewrites of existing files.
- **I7** Confirmation gate on every destructive/irreversible action.

## Getting started

```bash
pnpm install          # TypeScript workspace
uv sync --dev         # Python workspace
uv run python scripts/generate_secrets.py  # secure local .env for compose
```

Verify everything:

```bash
# TypeScript
pnpm format:check && pnpm lint && pnpm typecheck && pnpm test

# Python
uv run ruff format --check . && uv run ruff check .
uv run mypy services packages evals
uv run pytest

# Contracts, invariants, and the eval suite
uv run python packages/contracts/validate_schemas.py
uv run python scripts/check_invariants.py
uv run python -m loopit_evals.cli validate
```

`scripts/check_invariants.py` is a static guard over the invariants below — it fails the build if,
for example, a whole-file write tool is added or the egress default stops being `deny`. It runs on
every pull request and is not advisory.

## What runs today

| Component                 | State                                                                       |
| ------------------------- | --------------------------------------------------------------------------- |
| `packages/contracts`      | 4 JSON Schemas + TypeScript mirrors, with drift tests                       |
| `packages/patch`          | Unified-diff apply with hunk-context and stale-read rejection (I6)          |
| `packages/agent-core`     | ReAct loop, budgets, audit, untrusted fencing, reflection, context mgmt     |
| `packages/checkpoint`     | Content-addressed blobs + immutable checkpoint tree with CoW working sets   |
| `packages/verify`         | Tiered L0–L3 verification pipeline, cheap gates before expensive ones       |
| `packages/sandbox-sdk`    | Leases, the signed replay-proof channel, and the in-sandbox browser tool    |
| `services/scheduler`      | Warm pool, TTL/resource-capped leases, destroy-never-reuse recycling (I1)   |
| `services/egress-proxy`   | Default-deny policy, metadata + mining blocks, full request logging (I3/I4) |
| `services/preview-proxy`  | Signed per-project preview tokens; sandbox ports are never public (I1)      |
| `services/router-svc`     | Difficulty routing, pre-spend quota, server-side credentials (I5)           |
| `services/orchestrator`   | Temporal run client/workflows for durable execution; apps/api has an explicit local fallback for offline preview use |
| `apps/api`                | Authenticated FastAPI seam for runs, DAG/status, gates, checkpoints, metrics, and signed preview URLs |
| `apps/web`                | Customer-facing run board with onboarding prompts, actionable sanitized error states, retrying live streams, pricing/usage UX, checkpoints, gates, responsive layouts, and a health-backed status page |
| `docs/` launch docs       | Getting started, core concepts, troubleshooting/FAQ, privacy/data-handling summary, self-hosting pointer, and ordered go-live checklist |
| `sandbox/image`           | Digest-pinned base image with warmed caches and baked-in browsers           |
| `evals/harness` + `suite` | Tiered T0–T3 suite, functional scoring, plus a live Phase 1 gate executor that refuses to fabricate results when model/sandbox infra is absent |
| `evals/redteam`           | Escape, metadata-reach, egress-bypass and injection attacks; optional live sandbox probes skip unless explicitly configured |

The router now talks to **live models**. `OpenAICompatibleUpstream` speaks the OpenAI wire
protocol, so vLLM, a dedicated Hugging Face endpoint, and the hosted Inference Router are all a
`base_url` change apart. `scripts/smoke_model_endpoint.py` exercises the whole path — routing,
credential injection, quota, dispatch, token accounting, audit — against real models:

```bash
export HF_TOKEN=...                     # never committed
python scripts/smoke_model_endpoint.py --bill-to <org> --structured --max-tokens 16384
```

See [`infra/runbooks/deploy-model-endpoints-hf.md`](infra/runbooks/deploy-model-endpoints-hf.md)
for the model choices, the hosted-vs-dedicated tradeoff, and the reasoning-token budget that
governs both cost and correctness.

The eval harness now includes a real executor and `scripts/phase1_exit_gate.py` for the Phase 1 CRUD
self-correction gate. It wires the scheduler, signed sandbox runtime, tool registry, router-backed
model client, verification pipeline, and checkpoint capture, but it still refuses to report a pass
unless it is run against live Docker/E2B isolation with live model credentials.

## Current phase

**M7 / launch readiness.** Phase 0–5 code paths are implemented in the repository and the final
production-polish checklist is present, but this checkout has not executed the live infrastructure paths:
Temporal orchestration, real Docker/E2B sandboxes, hosted model endpoints, Stripe checkout/webhooks, Fly
deploys, OIDC, DNS, and TLS still require operator credentials and a first live deployment. The Phase 1 exit
gate runner exists:
`uv run python scripts/phase1_exit_gate.py --provider docker`, and it intentionally refuses to claim a pass
unless live sandbox/model infrastructure is configured.

## Contributing rules

- Any change to a locked decision or an invariant requires an **ADR** (`docs/adr/`).
- No PR ships without: invariants upheld, audit events emitted, evals green, red-team green.
- Never commit secrets. Never log them either.
