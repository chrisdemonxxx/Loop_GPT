import { toActivity, type Activity } from './activity'
import type {
  ApprovalGate,
  CheckpointView,
  RunCost,
  RunDetail,
  StreamEvent,
  TaskDagView,
  TaskNodeView,
} from './api'

export interface RunUiState {
  run: RunDetail | null
  activity: Activity[]
  dag: TaskDagView | null
  gates: ApprovalGate[]
  checkpoints: CheckpointView[]
  cost: RunCost | null
  error: string | null
}

export function emptyRunUiState(): RunUiState {
  return { run: null, activity: [], dag: null, gates: [], checkpoints: [], cost: null, error: null }
}

export function extractDag(run: RunDetail | null): TaskDagView | null {
  return run?.dag ?? run?.task_dag ?? null
}

export function extractGates(run: RunDetail | null): ApprovalGate[] {
  const gates = [...(run?.gates ?? [])]
  if (run?.gate) gates.push(run.gate)
  return gates.filter((gate) => gate.status !== 'approved' && gate.status !== 'rejected')
}

export function extractCost(run: RunDetail | null): RunCost | null {
  if (!run) return null
  const cost: RunCost = {
    iterations: run.cost?.iterations ?? run.iterations,
    credits_spent: run.cost?.credits_spent ?? run.credits_spent,
  }
  if (run.cost?.cost_usd !== undefined) cost.cost_usd = run.cost.cost_usd
  if (run.cost?.input_tokens !== undefined) cost.input_tokens = run.cost.input_tokens
  if (run.cost?.output_tokens !== undefined) cost.output_tokens = run.cost.output_tokens
  if (run.cost?.total_tokens !== undefined) cost.total_tokens = run.cost.total_tokens
  if (run.cost?.cost_per_successful_deploy !== undefined) {
    cost.cost_per_successful_deploy = run.cost.cost_per_successful_deploy
  }
  return cost
}

export function reduceRunEvent(state: RunUiState, event: StreamEvent): RunUiState {
  if (event.kind === 'audit') {
    return { ...state, activity: [...state.activity, toActivity(event, state.activity.length)] }
  }
  if (event.kind === 'run') {
    const gates = extractGates(event)
    return {
      ...state,
      run: event,
      dag: extractDag(event) ?? state.dag,
      gates: gates.length ? gates : state.gates,
      checkpoints: event.checkpoints ?? state.checkpoints,
      cost: extractCost(event),
    }
  }
  if (event.kind === 'dag') return { ...state, dag: event.dag }
  if (event.kind === 'gate') {
    const others = state.gates.filter((gate) => gate.gate_id !== event.gate.gate_id)
    const gates = event.gate.status === 'approved' || event.gate.status === 'rejected' ? others : [...others, event.gate]
    return { ...state, gates }
  }
  if (event.kind === 'checkpoints') return { ...state, checkpoints: event.checkpoints }
  if (event.kind === 'cost') return { ...state, cost: event.cost }
  return { ...state, error: event.message }
}

export function orderedDagNodes(dag: TaskDagView): TaskNodeView[] {
  const byId = new Map(dag.nodes.map((node) => [node.id, node]))
  const originalIndex = new Map(dag.nodes.map((node, index) => [node.id, index]))
  const emitted = new Set<string>()
  const ordered: TaskNodeView[] = []

  while (ordered.length < dag.nodes.length) {
    const ready = dag.nodes
      .filter((node) => !emitted.has(node.id))
      .filter((node) => node.dag_parents.every((parent) => !byId.has(parent) || emitted.has(parent)))
      .sort((left, right) => (originalIndex.get(left.id) ?? 0) - (originalIndex.get(right.id) ?? 0))
    if (!ready.length) return [...ordered, ...dag.nodes.filter((node) => !emitted.has(node.id))]
    for (const node of ready) {
      emitted.add(node.id)
      ordered.push(node)
    }
  }
  return ordered
}

export function isCompletedNode(node: TaskNodeView): boolean {
  return node.status === 'merged'
}

export function formatTokens(cost: RunCost | null): string {
  const total = cost?.total_tokens ?? ((cost?.input_tokens ?? 0) + (cost?.output_tokens ?? 0))
  return total ? total.toLocaleString() : 'not reported'
}

/**
 * Generated file lists are not ordered with the entrypoint first, so the
 * preview picks the first HTML file rather than files[0].
 */
export function pickPreviewFile(files: readonly string[]): string | undefined {
  return (
    files.find((path) => /(^|\/)index\.html?$/i.test(path)) ??
    files.find((path) => /\.html?$/i.test(path)) ??
    files[0]
  )
}
