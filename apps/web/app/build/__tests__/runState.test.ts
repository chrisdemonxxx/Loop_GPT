import { describe, expect, it } from 'vitest'
import {
  emptyRunUiState,
  extractCost,
  extractDag,
  extractGates,
  isCompletedNode,
  orderedDagNodes,
  pickPreviewFile,
  reduceRunEvent,
  type ApprovalGate,
  type RunDetail,
  type RunStreamEvent,
  type TaskDagView,
} from '@loop/loopit-client'

function run(partial: Partial<RunDetail> = {}): RunStreamEvent {
  return {
    kind: 'run',
    run_id: 'run-1',
    project_id: 'proj-1',
    prompt: 'Build a page',
    status: 'running',
    started_at: '2026-10-07T12:00:00.000Z',
    finished_at: null,
    iterations: 2,
    summary: '',
    credits_spent: 1.5,
    files: ['src/App.js', 'public/index.html'],
    ...partial,
  }
}

const pending: ApprovalGate = {
  gate_id: 'g1',
  action: 'deploy',
  reason: 'ships to production',
  destructive: true,
  status: 'pending',
}

describe('run state mapping', () => {
  it('prefers dag and falls back to task_dag', () => {
    const dag: TaskDagView = { plan_id: 'p', goal: 'one', nodes: [] }
    const other: TaskDagView = { plan_id: 'q', goal: 'two', nodes: [] }
    expect(extractDag(run({ dag, task_dag: other }))).toBe(dag)
    expect(extractDag(run({ dag: null, task_dag: other }))).toBe(other)
    expect(extractDag(run({ dag: null, task_dag: null }))).toBeNull()
    expect(extractDag(null)).toBeNull()
  })

  it('keeps open gates and drops ones already decided', () => {
    const approved: ApprovalGate = { ...pending, gate_id: 'g2', status: 'approved' }
    const singular: ApprovalGate = { ...pending, gate_id: 'g3' }
    const gates = extractGates(run({ gates: [pending, approved], gate: singular }))
    expect(gates.map((gate) => gate.gate_id)).toEqual(['g1', 'g3'])
  })

  it('fills cost from the run when the cost object is partial', () => {
    expect(extractCost(run({ cost: { input_tokens: 3 } }))).toMatchObject({
      iterations: 2,
      credits_spent: 1.5,
      input_tokens: 3,
    })
    expect(extractCost(null)).toBeNull()
  })

  it('folds stream events into the board state', () => {
    let state = emptyRunUiState()
    state = reduceRunEvent(state, {
      kind: 'audit',
      type: 'tool.called',
      outcome: 'success',
      occurred_at: '2026-10-07T12:00:01.000Z',
      detail: { tool: 'read_file', path: 'index.html' },
    })
    expect(state.activity).toHaveLength(1)
    expect(state.activity[0]?.title).toBe('Read a file')
    expect(state.activity[0]?.rawType).toBe('tool.called')

    const dag: TaskDagView = {
      plan_id: 'p',
      goal: 'ship',
      nodes: [{ id: 'a', goal: 'scaffold', dag_parents: [], expected_verification: [], destructive: false, status: 'running' }],
    }
    state = reduceRunEvent(state, { kind: 'dag', dag })
    expect(state.dag).toBe(dag)

    state = reduceRunEvent(state, { kind: 'gate', gate: pending })
    state = reduceRunEvent(state, { kind: 'gate', gate: { ...pending, status: 'approved' } })
    expect(state.gates).toEqual([])

    state = reduceRunEvent(state, {
      kind: 'checkpoints',
      checkpoints: [{ checkpoint_id: 'c1', parent_id: null, created_at: '2026-10-07T12:01:00.000Z', verified: true }],
    })
    expect(state.checkpoints.map((checkpoint) => checkpoint.checkpoint_id)).toEqual(['c1'])

    state = reduceRunEvent(state, { kind: 'cost', cost: { credits_spent: 4, total_tokens: 10 } })
    expect(state.cost).toMatchObject({ credits_spent: 4, total_tokens: 10 })

    const snapshot = run({ gates: [], status: 'verified' })
    state = reduceRunEvent(state, snapshot)
    expect(state.run?.status).toBe('verified')
    expect(state.dag).toBe(dag)
    expect(state.checkpoints).toHaveLength(1)

    state = reduceRunEvent(state, { kind: 'error', message: 'dropped' })
    expect(state.error).toBe('dropped')
  })

  it('orders a graph by dependencies and keeps sibling source order', () => {
    const dag: TaskDagView = {
      plan_id: 'p',
      goal: 'app',
      nodes: [
        { id: 'child', goal: 'page', dag_parents: ['base'], expected_verification: [], destructive: false },
        { id: 'side', goal: 'styles', dag_parents: [], expected_verification: [], destructive: false },
        { id: 'base', goal: 'scaffold', dag_parents: [], expected_verification: [], destructive: false },
      ],
    }
    expect(orderedDagNodes(dag).map((node) => node.id)).toEqual(['side', 'base', 'child'])
  })

  it('appends nodes that sit in a cycle', () => {
    const dag: TaskDagView = {
      plan_id: 'p',
      goal: 'loop',
      nodes: [
        { id: 'a', goal: 'a', dag_parents: ['b'], expected_verification: [], destructive: false },
        { id: 'b', goal: 'b', dag_parents: ['a'], expected_verification: [], destructive: false },
      ],
    }
    expect(orderedDagNodes(dag).map((node) => node.id)).toEqual(['a', 'b'])
  })

  it('treats merged nodes as completed and picks an html preview', () => {
    expect(isCompletedNode({ id: 'a', goal: '', dag_parents: [], expected_verification: [], destructive: false, status: 'merged' })).toBe(true)
    expect(isCompletedNode({ id: 'a', goal: '', dag_parents: [], expected_verification: [], destructive: false, status: 'running' })).toBe(false)
    expect(pickPreviewFile(['src/App.js', 'public/index.html', 'notes.html'])).toBe('public/index.html')
    expect(pickPreviewFile(['src/App.js'])).toBe('src/App.js')
  })
})
