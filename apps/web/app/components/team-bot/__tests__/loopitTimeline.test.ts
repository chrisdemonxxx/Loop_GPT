import { describe, expect, it } from 'vitest'
import type { RunDetail, StreamEvent } from '@loop/loopit-client'
import { loopitDetailToFeed, loopitStreamToFeed } from '../loopitTimeline'

const run: RunDetail = {
  run_id: 'run_abc123',
  project_id: 'proj_1',
  prompt: 'build',
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
  it('turns a run and its stream into timeline events', () => {
    const detail = loopitDetailToFeed(run)
    expect(detail.map((event) => event.type)).toEqual(['status', 'status', 'artifact'])
    expect(detail[0].message).toContain('waiting on a gate')
    expect(detail[1].message).toContain('gate_1')
    expect(detail[2].artifact?.name).toBe('green')

    const started: StreamEvent = {
      kind: 'audit',
      type: 'task.started',
      outcome: null,
      occurred_at: '2026-01-01T00:00:00Z',
      detail: { goal: 'todo app' },
    }
    expect(loopitStreamToFeed(started)?.message).toContain('Run started')
    expect(loopitStreamToFeed({ kind: 'error', message: 'sandbox down' })?.type).toBe('error')
    expect(loopitDetailToFeed(null)).toEqual([])
  })
})
