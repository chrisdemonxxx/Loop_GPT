# Model choice router, license gate, and low-refusal protocol

Loop-it's model layer is open by design, but all serving still flows through
`router-svc`, the only sandbox-to-model path (I5). Users and projects may select
registered model ids; they may not supply upstream URLs, headers, or credentials.
The router owns those fields server-side.

## Model catalog and selection

`router-svc` exposes:

- `GET /v1/models/catalog?org_id=<org>` — RBAC `org:read`; returns registered
  model ids, backend, upstream base URL, context window, pricing, capability
  tags, difficulty eligibility, and license id. It never returns credential refs
  or resolved credentials.
- `GET /v1/model-selection?org_id=<org>&project_id=<project>` — RBAC
  `project:read`; returns the effective per-difficulty fallback chain.
- `PUT /v1/model-selection` — RBAC `org:manage` for org defaults or
  `project:write` for project overrides; accepts only model ids from the
  catalog. Server validation rejects unknown models, ineligible difficulty
  mappings, upstream overrides, arbitrary headers, and credentials.

The fallback chain is ordered per difficulty. A trivial task may use a cheap
model first and then a stronger eligible fallback; implementation and planning
tasks use their own eligible chains. Fallbacks are explicit so degradations show
up in audit events.

## License gate

`loopit_model_licenses` owns the machine-readable register in
`packages/model-licenses/src/loopit_model_licenses/data/models.json` plus its
JSON Schema. Each model records base model, derivative lineage, license id and
URL, field-of-use restrictions, commercial-use status, attribution and
redistribution requirements, verifier, and `last_verified`.

Before any router dispatch, `assert_servable_commercially(model_id)` runs. It
fails closed if the model is unregistered, non-commercial, has a future
verification date, or is stale beyond `LOOPIT_MODEL_LICENSE_MAX_AGE_DAYS`
(default: 120). `scripts/check_model_licenses.py` is the CI-friendly audit.

## Low-refusal / abliterated model protocol

Low-refusal models are model-content choices. They do not relax sandbox
isolation, tenant separation, egress controls, or infrastructure-abuse
enforcement. Those remain separate paths under I11 and docs `08`/`10`.

Ship/no-ship rule:

1. Run the BASE model on the real T0–T3 eval harness.
2. Run the MODIFIED model on the same tasks, attempts, seeds where available,
   budgets, and infrastructure.
3. Compare real result files with:

   ```bash
   uv run python -m loopit_evals.cli compare-models \
     --base-results evals/results/base.json \
     --modified-results evals/results/modified.json \
     --tolerance 0.02
   ```

4. Ship only if no coding or reasoning pass@1 cell regresses beyond tolerance.
   Any significant tier/capability regression is `no_ship`.

The comparison refuses to produce a verdict unless both inputs are marked as
real eval runs with measured tasks and capability summaries. No fabricated
numbers are accepted.
