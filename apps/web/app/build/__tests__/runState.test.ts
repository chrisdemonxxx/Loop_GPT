import { describe, expect, it } from 'vitest'
import {
  cleanPromptTitle,
  emptyRunUiState,
  extractCost,
  extractDag,
  extractGates,
  isCompletedNode,
  orderedDagNodes,
  pickPreviewFile,
  reduceRunEvent,
  runTitle,
  toActivity,
  type Activity,
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
    expect(state.activity[0]?.title).toBe('Reviewed part of the project')
    expect(state.activity[0]?.body).toBe('index.html')
    // Product voice: the audit's internal event name never reaches the UI.
    expect('rawType' in (state.activity[0] as Activity)).toBe(false)
    expect(JSON.stringify(state.activity[0])).not.toContain('tool.called')

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

describe('run titles', () => {
  it('prefers the brief title and never shows the raw request', () => {
    expect(runTitle({ title: 'Customer Intake Form', prompt: 'just build this' })).toBe('Customer Intake Form')
    expect(runTitle({ prompt: 'please just build me a landing page' })).toBe('A landing page')
    expect(runTitle({ prompt: 'Build a customer intake form' })).toBe('A customer intake form')
    expect(runTitle({ prompt: '' })).toBe('Untitled build')
    expect(runTitle(null)).toBe('Untitled build')
  })

  it('keeps the first clause only', () => {
    expect(cleanPromptTitle('Build a form. It should also have a table.')).toBe('A form')
  })
})

describe('activity in product voice', () => {
  const at = '2026-10-07T12:00:00.000Z'

  it('names tools in plain language and shows only the files they touched', () => {
    const edit = toActivity(
      { kind: 'audit', type: 'tool.called', outcome: 'success', occurred_at: at, detail: { tool: 'apply_patch', args: { patch: '--- /dev/null\n+++ b/App.js\n@@\n+x' } } },
      0,
    )
    expect(edit.title).toBe('Wrote changes')
    expect(edit.body).toBe('App.js')

    const read = toActivity(
      { kind: 'audit', type: 'tool.called', outcome: 'success', occurred_at: at, detail: { tool: 'search_code', query: 'find the form handler' } },
      1,
    )
    expect(read.title).toBe('Scanned the project')
    expect(read.body).toBe('')
  })

  it('never surfaces commands, event names, or raw model text', () => {
    const shell = toActivity(
      { kind: 'audit', type: 'tool.called', outcome: 'success', occurred_at: at, detail: { tool: 'run_shell', command: 'rm -rf /tmp/x', args: { command: 'rm -rf /tmp/x' } } },
      0,
    )
    expect(shell.title).toBe('Ran a setup command')
    expect(shell.body).toBe('')
    expect(JSON.stringify(shell)).not.toContain('rm -rf')

    const unknown = toActivity(
      { kind: 'audit', type: 'model.fenced_future_event', outcome: 'success', occurred_at: at, detail: { tool: 'new_tool' } },
      1,
    )
    expect(unknown.title).toBe('Working…')
    expect(JSON.stringify(unknown)).not.toContain('model.fenced_future_event')

    const result = toActivity(
      { kind: 'audit', type: 'tool.result', outcome: 'failure', occurred_at: at, detail: { observation: 'stack trace: TypeError at line 1' } },
      2,
    )
    expect(result.title).toBe('A step did not go as planned')
    expect(result.body).toBe('')
    expect(JSON.stringify(result)).not.toContain('stack trace')
  })

  it('reports verification and completion as outcomes a person reads', () => {
    const passed = toActivity({ kind: 'audit', type: 'task.completed', outcome: 'success', occurred_at: at, detail: { summary: 'stopped: whatever' } }, 0)
    expect(passed.title).toBe('Build verified')
    expect(passed.body).toBe('')
    const failed = toActivity({ kind: 'audit', type: 'verification.completed', outcome: 'failure', occurred_at: at, detail: { verdict: 'nope' } }, 1)
    expect(failed.title).toBe('The checks found something to fix')
    expect(failed.body).toBe('')
  })
})
