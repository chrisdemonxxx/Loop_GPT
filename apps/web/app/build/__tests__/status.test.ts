import { describe, expect, it } from 'vitest'
import { formatWhen, isLiveStatus, statusLabel, statusStepper, statusTone } from '../status'

describe('Build status vocabulary', () => {
  it('keeps every in-flight status live, not just running', () => {
    for (const status of ['queued', 'running', 'awaiting_approval', 'awaiting_gate', 'verifying', 'checkpointing']) {
      expect(isLiveStatus(status)).toBe(true)
    }
    for (const status of ['verified', 'error', 'failed', 'merged', '', undefined, null]) {
      expect(isLiveStatus(status)).toBe(false)
    }
  })

  it('maps statuses to badge tones', () => {
    expect(statusTone('verified')).toBe('green')
    expect(statusTone('FAILED')).toBe('rose')
    expect(statusTone('running')).toBe('accent')
    expect(statusTone('awaiting_approval')).toBe('amber')
    expect(statusTone('something_new')).toBe('neutral')
  })

  it('humanizes raw statuses', () => {
    expect(statusLabel('awaiting_approval')).toBe('Needs approval')
    expect(statusLabel('running')).toBe('Running')
    expect(statusLabel('rate_limited')).toBe('Rate limited')
    expect(statusLabel('')).toBe('Pending')
  })

  it('gives queued and awaiting approval their own stepper labels', () => {
    expect(statusStepper('queued')).toMatchObject({ steps: ['Queued', 'Building', 'Verifying', 'Done'], current: 0 })
    expect(statusStepper('awaiting_approval').steps[0]).toBe('Needs approval')
    expect(statusStepper('awaiting_gate').steps[0]).toBe('Needs approval')
    expect(statusStepper('running').steps[statusStepper('running').current]).toBe('Building')
    expect(statusStepper('planning').steps[0]).toBe('Planning')
  })

  it('formats dates and passes unparseable input through', () => {
    expect(formatWhen('not a date')).toBe('not a date')
    expect(formatWhen(null)).toBe('')
    expect(formatWhen('2026-10-07T12:00:00Z')).not.toBe('')
  })
})
