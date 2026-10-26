import { describe, expect, it } from 'vitest'
import { computerLevel, rosterPresence } from '../presence'

describe('roster presence', () => {
  it('shows idle, thinking, working, waiting, blocked, or done, and the hover is the current action', () => {
    expect(rosterPresence({})).toEqual({ state: 'idle', action: 'Idle' })
    expect(rosterPresence({ status: 'queued' })).toMatchObject({ state: 'thinking' })
    expect(rosterPresence({ status: 'processing', action: 'Looking that up' })).toEqual({
      state: 'working',
      action: 'Looking that up',
    })
    expect(rosterPresence({ status: 'processing', needsHelp: true, action: 'Needs a click on the desktop' })).toEqual({
      state: 'waiting',
      action: 'Needs a click on the desktop',
    })
    expect(rosterPresence({ status: 'dead_letter', action: 'The desktop did not come up' })).toEqual({
      state: 'blocked',
      action: 'The desktop did not come up',
    })
    expect(rosterPresence({ status: 'succeeded', action: 'Posted the summary' })).toEqual({
      state: 'done',
      action: 'Posted the summary',
    })
  })
})

describe('computer levels', () => {
  it('keeps a status mark, a side preview while chat stays up, and takeover only when the bot needs help', () => {
    expect(computerLevel({ chatOpen: false, needsHelp: false })).toBe('mark')
    expect(computerLevel({ chatOpen: true, needsHelp: false })).toBe('preview')
    expect(computerLevel({ chatOpen: true, needsHelp: true })).toBe('takeover')
  })
})
