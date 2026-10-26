import { describe, expect, it } from 'vitest'
import { teachDistillPrompt, teachEnd, teachNeedsTakeover } from '../teachPlan'

describe('teach plan', () => {
  it('puts the chosen name and description into the distill prompt', () => {
    const prompt = teachDistillPrompt(3, '1. click Export', { name: 'Invoice export', description: 'Pull the CSV from billing' })
    expect(prompt).toContain('Invoice export')
    expect(prompt).toContain('Pull the CSV from billing')
    expect(prompt).toContain('3')
  })

  it('discards the recording and cancel does not', () => {
    expect(teachEnd('discard')).toEqual({ deleteRecording: true, event: 'teach_discarded' })
    expect(teachEnd('cancel')).toEqual({ deleteRecording: false, event: null })
  })

  it('learns from a saved recording without waiting for takeover', () => {
    expect(teachNeedsTakeover(undefined)).toBe(true)
    expect(teachNeedsTakeover('rec-1')).toBe(false)
  })
})
