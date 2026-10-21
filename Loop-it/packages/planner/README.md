# loopit-planner

`loopit-planner` owns Phase 3's DAG shape and merge policy rather than placing it inside
`services/orchestrator`.

The planner is a package because DAG validation, conflict detection, quota-aware scheduling, and
re-planning are pure platform rules reused by the Temporal orchestrator, API previews, and offline
evals. The orchestrator remains the durable execution owner: it calls these APIs from workflows and
activities, while all generated-code execution still happens through sandbox leases in the data
plane.

## Phase 3 rules encoded here

- Planner output is constrained by `packages/contracts/schemas/task-dag.schema.json`.
- Every node is normalised against `loopit_agent_core.vocabulary` and `loopit_policy`:
  verification may be raised but never lowered, and destructive work is flagged for I7 gates.
- Parallel agents fork copy-on-write working sets from the same green checkpoint.
- Merge winners are deterministic: lower topological rank wins, then lexicographically lower node id.
- Conflicting losers are never blindly 3-way merged. They re-run on the winner's checkpoint, and only
  the remaining DAG is revised.
