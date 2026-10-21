import { describe, expect, it } from 'vitest'
import { emptyRunUiState, reduceRunEvent } from '@loop/loopit-client'

describe('Phase 2.7 / 2.9 client surfaces', () => {
  it('RunSummary-shaped events keep background and pending_review_id', () => {
    let state = emptyRunUiState()
    state = reduceRunEvent(state, {
      kind: 'run',
      run_id: 'run_bg',
      project_id: 'proj_1',
      prompt: 'ship it',
      status: 'verified',
      background: true,
      pending_review_id: 'rev_abc',
      base_checkpoint_id: 'ckpt_base',
      started_at: new Date().toISOString(),
      finished_at: new Date().toISOString(),
      iterations: 1,
      summary: 'done',
      credits_spent: 0,
      files: ['App.js'],
    } as never)
    expect(state.run?.background).toBe(true)
    expect(state.run?.pending_review_id).toBe('rev_abc')
  })

  it('file_change events still accumulate for Apply review diffs', () => {
    let state = emptyRunUiState()
    state = reduceRunEvent(state, {
      kind: 'file_change',
      path: 'App.js',
      op: 'modify',
      diff: '--- a/App.js\n+++ b/App.js\n+hello\n',
      additions: 1,
      deletions: 0,
    })
    expect(state.fileChanges).toHaveLength(1)
    expect(state.fileChanges[0]?.diff).toContain('+hello')
  })
})
