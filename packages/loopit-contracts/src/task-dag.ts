/**
 * Planner output types (Doc 04 §2).
 *
 * A plan is a DAG rather than a list because independent tasks should fork from
 * the same green checkpoint and run in parallel. The sequential-list shape most
 * agent frameworks default to serialises work that has no reason to be
 * sequential.
 */

/**
 * Verification layers, cheapest first. A layer only runs once the ones before it
 * are green, so an expensive browser smoke test is never spent on code that does
 * not typecheck.
 */
export const VERIFICATION_LAYERS = [
  'L0_typecheck_lint',
  'L1_tests',
  'L2_browser_smoke',
  'L2_5_sast',
  'L3_visual_diff',
] as const

export type VerificationLayer = (typeof VERIFICATION_LAYERS)[number]

/**
 * The closed vocabulary of task kinds for the supported stack (P2-6).
 *
 * Narrowing the planner to these turns each node into something the platform
 * knows how to scope: each kind carries a tool allowlist and a verification
 * floor that the planner may raise but never lower. Keep this in step with
 * `packages/agent-core/src/loopit_agent_core/vocabulary.py` — a contract that
 * drifts from the implementation validates plans the implementation cannot run.
 */
export const TASK_KINDS = [
  'scaffold_project',
  'add_table',
  'add_api_route',
  'add_ui_page',
  'add_ui_component',
  'wire_auth',
  'add_dependency',
  'write_tests',
  'fix_verification_failure',
  'deploy',
] as const

export type TaskKind = (typeof TASK_KINDS)[number]

/** Every loop is bounded (invariant I12). Omitted fields inherit the run budget. */
export interface Budget {
  max_iterations?: number
  max_tokens?: number
  max_wall_clock_seconds?: number
  max_credits?: number
}

export interface TaskNode {
  id: string
  /** Determines the tool allowlist and the verification floor (P2-6). */
  kind: TaskKind
  goal: string
  /** Node ids this task depends on. Empty means it forks from the plan base. */
  dag_parents: string[]
  /** Green checkpoint to fork from. Omitted means the plan's base checkpoint. */
  fork_checkpoint_id?: string
  expected_verification: VerificationLayer[]
  /**
   * True if the task deletes data, alters production schema, deploys, spends
   * money, writes externally, or rotates secrets. True forces a human
   * confirmation gate (invariant I7).
   */
  destructive: boolean
  /** Required when `destructive` is true; shown to the human in the gate prompt. */
  destructive_reason?: string
  budget?: Budget
}

export interface TaskDAG {
  plan_id: string
  goal: string
  /** Immutable checkpoint the plan forks from. Runs never execute against mutable files. */
  base_checkpoint_id?: string
  nodes: TaskNode[]
}

export interface DagValidationError {
  code: 'unknown-parent' | 'cycle' | 'duplicate-id' | 'missing-destructive-reason'
  message: string
  nodeId?: string
}

/**
 * Structural checks the JSON Schema cannot express.
 *
 * Cycles in particular are invisible to JSON Schema, and an undetected cycle
 * turns a plan into a scheduler deadlock rather than an obvious error.
 */
export function validateDag(dag: TaskDAG): DagValidationError[] {
  const errors: DagValidationError[] = []
  const byId = new Map<string, TaskNode>()

  for (const node of dag.nodes) {
    if (byId.has(node.id)) {
      errors.push({
        code: 'duplicate-id',
        message: `duplicate node id '${node.id}'`,
        nodeId: node.id,
      })
      continue
    }
    byId.set(node.id, node)
  }

  for (const node of dag.nodes) {
    if (node.destructive && !node.destructive_reason) {
      errors.push({
        code: 'missing-destructive-reason',
        message: `node '${node.id}' is destructive but gives no reason to show the human`,
        nodeId: node.id,
      })
    }
    for (const parent of node.dag_parents) {
      if (!byId.has(parent)) {
        errors.push({
          code: 'unknown-parent',
          message: `node '${node.id}' depends on unknown node '${parent}'`,
          nodeId: node.id,
        })
      }
    }
  }

  for (const node of findCycle(dag.nodes, byId)) {
    errors.push({
      code: 'cycle',
      message: `node '${node}' takes part in a dependency cycle`,
      nodeId: node,
    })
  }

  return errors
}

/** Returns the ids of nodes that cannot be topologically ordered. */
function findCycle(nodes: TaskNode[], byId: Map<string, TaskNode>): string[] {
  const resolved = new Set<string>()
  let progressed = true

  while (progressed) {
    progressed = false
    for (const node of nodes) {
      if (resolved.has(node.id)) continue
      const ready = node.dag_parents.every((parent) => !byId.has(parent) || resolved.has(parent))
      if (ready) {
        resolved.add(node.id)
        progressed = true
      }
    }
  }

  return nodes.filter((node) => !resolved.has(node.id)).map((node) => node.id)
}

/** Nodes that may start now, given the set already completed. */
export function readyNodes(dag: TaskDAG, completed: ReadonlySet<string>): TaskNode[] {
  return dag.nodes.filter(
    (node) => !completed.has(node.id) && node.dag_parents.every((parent) => completed.has(parent)),
  )
}
