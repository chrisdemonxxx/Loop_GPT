/**
 * Roster presence and the three computer levels.
 * idle, thinking, working, waiting, blocked, done.
 * Hover text is the current action.
 * Computer: a status mark, a side preview while chat stays up,
 * and full takeover only when the bot needs help.
 */

export type PresenceState = 'idle' | 'thinking' | 'working' | 'waiting' | 'blocked' | 'done'

export function rosterPresence(input: {
  status?: string | null
  action?: string | null
  needsHelp?: boolean
}): { state: PresenceState; action: string } {
  const action = (input.action || '').trim()
  if (input.status === 'dead_letter' || input.status === 'failed') {
    return { state: 'blocked', action: action || 'Blocked' }
  }
  if (input.needsHelp) return { state: 'waiting', action: action || 'Waiting for you' }
  if (input.status === 'processing') return { state: 'working', action: action || 'Working' }
  if (input.status === 'queued') return { state: 'thinking', action: action || 'Thinking' }
  if (input.status === 'succeeded') return { state: 'done', action: action || 'Done' }
  return { state: 'idle', action: action || 'Idle' }
}

export type ComputerLevel = 'mark' | 'preview' | 'takeover'

export function computerLevel(input: { chatOpen: boolean; needsHelp: boolean }): ComputerLevel {
  if (input.needsHelp) return 'takeover'
  if (input.chatOpen) return 'preview'
  return 'mark'
}
