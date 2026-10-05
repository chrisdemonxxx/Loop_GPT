# Validation: HF-sandbox isolation mode for execute_code (Phase 2)

Date: 2026-10-05. Branch: `release/owned-staging-20260917`.
Scope: managed code-execution isolation via dedicated HF Sandbox VMs
(`SANDBOX_PROVIDER=hf`), the third `execute_code` backend alongside
docker/subprocess.

## What was built

- `src/services/hfSandbox.ts` — dedicated-mode HF Sandbox client, wire-verified
  against `huggingface_hub/_sandbox.py` (server v0.7.0, protocol 3) and
  `huggingface/sandbox-server`:
  - Job spec mirrors `_bootstrap_job_spec`/`_create_job_spec` exactly:
    digest-pinned server bootstrap (`SANDBOX_SERVER_SHA256
    eb2b04f7…5584932`), `SBX_TOKEN` HMAC derivation
    (`HMAC-SHA256(hfToken, "hf-sandbox:"+nonce)`), labels
    (`hf-sandbox=1`, `hf-sandbox-mode=dedicated`, `hf-sandbox-nonce`),
    server-bucket volume mount fallback, `expose.ports=[49983]`, 24h job cap.
  - Readiness: `/health` poll with protocol >= 3 check + terminal-stage
    fast-fail; startup failure always cancels the job (no orphan billing).
  - Exec: NDJSON stream parse (start/stdout/stderr/ping/exit), live chunk
    callbacks, 512KB capture cap.
  - Files: write (parents auto-created) / read / list for artifact collection.
  - Egress discipline: requests only to the hub endpoint and `*.hf.jobs`;
    redirects are never followed (credential-leak guard); HF token never
    enters the sandbox (no `forward_hf_token`).
  - Error taxonomy: 402 → `billing`, 401/403 → `auth`, 404 → `not_found`,
    5xx → `unavailable`.
- `src/agent/tools/executeCode.ts` — `SANDBOX_PROVIDER` (`hf`/`docker`/
  `subprocess`, empty = auto) with legacy `SANDBOX_DOCKER` honored; the `hf`
  path provisions a VM per run, uploads the snippet, execs with the existing
  live-output batcher, collects produced files as artifacts, and always kills
  the sandbox in `finally` (idle-timeout watchdog is the billing backstop).
  Billing/auth failures return a clear operator-facing message, not a crash.

## Evidence (raw)

Typecheck/build: `tsc --noEmit` 0; `npm run build` 0.
Unit: **17 new tests pass** (`hfSandbox.test.ts`): token HMAC vector, job-spec
shape (labels/secrets/env/volumes/expose), create happy path (spec body +
auth headers asserted), 402 → billing, startup-failure job cancel (no orphan),
protocol refusal, NDJSON parsing + callbacks, payload/headers, 403 → auth,
non-HF host refusal (no request issued), missing exit event, kill 404
tolerance, provider env precedence. Full suite: **69 files, 1230 passed** (was
1213 before this phase).

Live wire probe (`scripts/sandbox-probe.mjs`, since removed; real `HF_TOKEN`
from backend/.env):
```
PROBE RESULT: billing - HF Jobs billing: sandboxes need a positive HF credit balance (402)
```
The request passed auth and spec validation and reached the billing gate —
the wire is correct end-to-end. **Full live execution is externally blocked
until the HF account has a positive Jobs credit balance** (same 402 wall the
roster recorded for the HF router models).

## Limits

- Live VM execution unverified until HF credits exist; the mocked-wire tests
  cover the client contract, the probe covers auth/spec/billing mapping.
- `cpu-basic` flavor, ~6s cold start per run (paid per second); idle watchdog
  600s default is the leak backstop, `kill` in `finally` is the primary.
- Default remains auto (docker → subprocess). Ship `SANDBOX_PROVIDER=hf` only
  after topping up HF Jobs credits; the error path degrades cleanly to a
  readable message if billing lapses.
