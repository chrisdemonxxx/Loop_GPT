import { describe, expect, it } from 'vitest'
import { emptyRunUiState, reduceRunEvent } from '@loop/loopit-client'
import { isImageFile } from '../attachments'

describe('Phase 1 local UX', () => {
  it('reduceRunEvent accumulates file_change events', () => {
    let state = emptyRunUiState()
    state = reduceRunEvent(state, {
      kind: 'file_change',
      path: 'App.js',
      op: 'modify',
      diff: '--- a/App.js\n+++ b/App.js\n',
      additions: 3,
      deletions: 1,
    })
    expect(state.fileChanges).toHaveLength(1)
    expect(state.fileChanges[0]?.path).toBe('App.js')
    expect(state.fileChanges[0]?.additions).toBe(3)
  })

  it('emptyRunUiState includes fileChanges', () => {
    expect(emptyRunUiState().fileChanges).toEqual([])
  })

  it('isImageFile accepts png/jpeg mime and extensions', () => {
    expect(isImageFile(new File([], 'x.png', { type: 'image/png' }))).toBe(true)
    expect(isImageFile(new File([], 'x.jpg', { type: 'image/jpeg' }))).toBe(true)
    expect(isImageFile(new File([], 'x.txt', { type: 'text/plain' }))).toBe(false)
  })
})
