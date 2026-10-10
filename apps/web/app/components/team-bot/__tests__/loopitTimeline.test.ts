import { describe, expect, it } from 'vitest'
import type { RunDetail, StreamEvent } from '@loop/loopit-client'
import { loopitDetailToFeed, loopitStreamToFeed } from '../loopitTimeline'

const run: RunDetail = {
  run_id: 'run_abc123',
  project_id: 'proj_1',
  prompt: 'build',
  title: 'Intake Form',
  status: 'awaiting_approval',
  started_at: '2026-01-01T00:00:00Z',
  finished_at: null,
  iterations: 1,
  summary: 'waiting on a gate',
  credits_spent: 0,
  files: [],
  gates: [{ gate_id: 'gate_1', action: 'deploy', reason: 'ship it', destructive: true, status: 'pending' }],
  checkpoints: [{ checkpoint_id: 'cp_1', parent_id: null, label: 'green', created_at: '2026-01-01T00:00:00Z', verified: true }],
}

describe('loopit timeline mapping', () => {
  it('turns a run and its stream into timeline events in product voice', () => {
    const detail = loopitDetailToFeed(run)
    expect(detail.map((event) => event.type)).toEqual(['status', 'status', 'artifact'])
    expect(detail[0].message).toContain('Needs approval')
    // The gate reads as a sentence, and neither the gate id nor the raw
    // action name is shown.
    expect(detail[1].message).toContain('publish this build')
    expect(detail[1].message).not.toContain('gate_1')
    expect(detail[1].message).not.toContain('deploy')
    expect(detail[2].artifact?.name).toBe('Version 1')

    const started: StreamEvent = {
      kind: 'audit',
      type: 'task.started',
      outcome: null,
      occurred_at: '2026-01-01T00:00:00Z',
      detail: { goal: 'todo app' },
    }
    expect(loopitStreamToFeed(started)?.message).toContain('Started building')
    expect(loopitStreamToFeed({ kind: 'error', message: 'sandbox down' })?.type).toBe('error')
    expect(loopitDetailToFeed(null)).toEqual([])
  })

  it('never surfaces raw ids from stream events', () => {
    const runEvent: StreamEvent = {
      kind: 'run',
      run_id: 'run_abc123',
      project_id: 'proj_1',
      prompt: 'build',
      title: 'Intake Form',
      status: 'verified',
      started_at: '2026-01-01T00:00:00Z',
      finished_at: null,
      iterations: 2,
      summary: 'Built and verified.',
      credits_spent: 0,
      files: [],
    }
    const message = loopitStreamToFeed(runEvent)?.message ?? ''
    expect(message).toContain('Verified')
    expect(message).not.toContain('run_abc123')

    const unknownTool: StreamEvent = {
      kind: 'audit',
      type: 'internal.future_event',
      outcome: 'success',
      occurred_at: '2026-01-01T00:00:00Z',
      detail: { tool: 'mystery_tool', command: 'rm -rf /' },
    }
    const toolLine = loopitStreamToFeed(unknownTool)?.message ?? ''
    expect(toolLine).not.toContain('internal.future_event')
    expect(toolLine).not.toContain('rm -rf')
  })
})
