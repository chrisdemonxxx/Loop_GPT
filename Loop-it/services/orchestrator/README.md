# loopit-orchestrator

Temporal owns durable run execution for Loop-it. `RunWorkflow` replaces the API's process-local `RunManager` thread with a workflow that records status, enforces I12 budgets in deterministic workflow code, and performs all I/O in activities.

## Architecture

- **Workflow (`loopit_orchestrator.workflow.RunWorkflow`)**: plans/iterates/verifies/checkpoints/completes a run; exposes `status` and `progress` queries; accepts `approve_gate` signals.
- **DAG workflows (`loopit_orchestrator.dag_workflow`)**: `ParallelDagWorkflow` plans a
  schema-valid task DAG, starts independent `DagNodeWorkflow` children concurrently, verifies each
  candidate checkpoint through L0→L2, and calls a merge activity before advancing the project
  checkpoint.
- **Activities (`loopit_orchestrator.activities`)**: acquire/release scheduler leases, execute one router/tool step, run verification, write a checkpoint, and emit audit events. Activities use retry policy derived from `loopit_policy.failures`: transient failures retry; verification, budget, gate-rejected, merge-conflict, and hard-error outcomes do not blind-retry.
- **DAG activities (`loopit_orchestrator.dag_activities`)**: invoke the planner service, execute one
  node through a sandbox dispatch endpoint, run the verification sub-agent, merge checkpoints, and
  revise only unfinished DAG nodes after conflicts or gate failures.
- **I1**: the orchestrator never executes generated code. Tool execution must go through a leased sandbox/workspace dispatch endpoint.
- **I7**: destructive or irreversible actions classified by `loopit_policy.classify_action` pause the workflow for an approval signal. The workflow releases the sandbox lease before waiting, so no process or lease is held during a human pause.
- **I12**: iteration, token, wall-clock, and credit budgets are enforced by workflow state before every step and after every activity usage delta.

`RunWorkflow` carries a bounded recent transcript between durable activity calls so the router sees
prior assistant actions and sandbox observations instead of restarting from the original prompt each
iteration. The cap is deliberate: Temporal serializes activity inputs into workflow history, so the
orchestrator stores only recent context until a blob/checkpoint transcript store exists.

The step activity timeout is `1740s`: `1080s` router failover budget plus `180s` router HTTP
headroom, `420s` workspace-dispatch HTTP budget, and `60s` Temporal/activity overhead. The
dispatch budget covers tool execution plus workspace manifest hashing/checkpointing after mutating
tools, while keeping the whole step inside Temporal's outer activity timeout.

`loopit-planner` is a package rather than a private orchestrator module so DAG validation,
destructiveness normalisation, conflict detection, deterministic winner selection, and offline eval
scenarios can be reused outside Temporal. The orchestrator still owns durability: parallel forks are
Temporal child workflows, and activities fail closed when the planner, sandbox dispatcher, or
checkpoint merge endpoint is absent.

## Running locally

```powershell
uv sync --all-extras --dev
$env:LOOPIT_TEMPORAL_ADDRESS = "localhost:7233"
$env:LOOPIT_TEMPORAL_NAMESPACE = "default"
$env:LOOPIT_TEMPORAL_TASK_QUEUE = "loopit-runs"
uv run python -m loopit_orchestrator.worker
```

Docker Compose includes a single-node Temporal dev server (no Elasticsearch) and an `orchestrator` worker service:

```powershell
docker compose up temporal orchestrator
```

Environment variables:

- `LOOPIT_TEMPORAL_ADDRESS` (default `localhost:7233`, compose `temporal:7233`)
- `LOOPIT_TEMPORAL_NAMESPACE` (default `default`)
- `LOOPIT_TEMPORAL_TASK_QUEUE` (default `loopit-runs`)
- `LOOPIT_SCHEDULER_URL` (default compose `http://scheduler:8004`)
- `LOOPIT_ROUTER_URL` (default compose `http://router-svc:8001`)
- `LOOPIT_ROUTER_HTTP_TIMEOUT_SECONDS` (minimum/default `1260`). The router can spend
  `2 candidates * 3 attempts * 180s = 1080s` on upstream failover; the orchestrator adds 180s
  headroom and will not use a lower HTTP timeout.
- `LOOPIT_WORKSPACE_DISPATCH_HTTP_TIMEOUT_SECONDS` (minimum/default `420`). Workspace dispatch
  covers sandbox tool execution plus manifest hashing/checkpointing before returning.
- `LOOPIT_VERIFY_HTTP_TIMEOUT_SECONDS` (minimum/default `1140`). Verification dispatch runs the
  full sandbox verification pipeline synchronously and needs to fit within the 20-minute Temporal
  verification activity budget.
- `LOOPIT_WORKSPACE_DISPATCH_URL` for the sandbox data-plane tool dispatcher. If unset, activities fail closed rather than executing locally.
- Workflow budget fields are serialized in `RunWorkflowInput`; callers should resolve deployment
  configuration before starting the workflow. Defaults are `100` iterations, `8000000` tokens,
  `14400` seconds (four hours), and `10.0` credits. At roughly `$0.005` per implementation-tier
  model call, this covers expected retry traffic for the default iteration cap without making
  fully degraded loops effectively unbounded.
- Sandbox lease TTL is serialized in `AcquireLeaseInput`/`RenewLeaseInput` before activity
  execution. The deterministic default is `3600` seconds. The workflow holds one lease across
  normal iterations and renews it before subsequent steps, but still releases before approval waits
  and at completion/failure so a crashed worker is bounded by the scheduler TTL.

## apps/api migration contract

Do not keep `RunManager` as the execution owner. Replace its calls with `loopit_orchestrator.client.OrchestratorClient`:

- `RunManager.start(RunRequest)` → build a `RunWorkflowInput` and call `await OrchestratorClient.start(input)`. Use `OrchestratorClient.workflow_id(run_id)` if the API needs to correlate Temporal IDs.
- `RunManager.get(run_id)` → `await OrchestratorClient.get(run_id)` returning `WorkflowStatus` (`run_id`, `project_id`, `status`, `iterations`, `credits`, `summary`, `checkpoint_id`, `gate`).
- `RunManager.next_event/subscribe` → poll/query `progress(run_id)` or subscribe to persisted audit/run events once API wiring lands; execution state no longer lives in an API queue.
- Approval endpoints should call `approve(run_id, ApprovalSignal(gate_id, True, actor_id, reason))` or `reject(run_id, gate_id, actor_id=..., reason=...)`.
- Workspace/project file reads should come from store/checkpoint/sandbox APIs, not from a `RunManager.workspace()` process dictionary.

The client API deliberately mirrors the current surface (`start`, `get`, `progress`, approval) while returning durable Temporal-backed state.
