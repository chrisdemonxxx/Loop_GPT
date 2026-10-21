# apps/web

The web app reads its API base URL at runtime from `window.__LOOPIT_API_BASE_URL__`, populated by `/loopit-config.js`. The Docker image defaults browser calls to `/api` while nginx proxies that path to `LOOPIT_API_BASE_URL`, so the same image can run locally or in production without rebuilding.

Identity tokens are stored in `sessionStorage`, not `localStorage`: the current API returns bearer tokens rather than HttpOnly cookies, and session-scoped storage avoids persistent token reuse after the browser session ends.

## Follow-up apps/api endpoints required

The UI defines and tests these client calls, but the current local-preview API does not expose them yet:

- Return DAG state on `GET /api/runs/{run_id}` or SSE: `dag`/`task_dag.nodes[].status` with `pending|running|verifying|blocked|merged|failed`.
- Return pending approval gates on run detail/SSE and implement `POST /api/runs/{run_id}/gates/{gate_id}/approve` plus `/reject` mapping to orchestrator `approve(run_id, ApprovalSignal(...))`/`reject(...)`.
- Return checkpoint tree on run detail/SSE and implement `POST /api/projects/{project_id}/checkpoints/{checkpoint_id}/rollback` plus `/fork`.
- Return per-run token/cost data and optional `cost_per_successful_deploy` in `run.cost`.
- Serve previews for authenticated browser sessions through the `/api/projects/{project_id}/site/t/{preview_token}/{path}` path; iframe requests cannot attach bearer headers, and a query-string token authenticates only the entry document while every relative subresource 401s.
