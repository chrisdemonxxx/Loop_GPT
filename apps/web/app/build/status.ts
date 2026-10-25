/**
 * One Build status vocabulary for every surface (the /build board, the run
 * view, the chat run card): which statuses are still moving, how each reads,
 * and which badge tone it takes.
 */
export type StatusTone = 'neutral' | 'accent' | 'green' | 'amber' | 'rose'

/** Statuses that can still change on the server: keep polling + streaming. */
export const LIVE_STATUSES: ReadonlySet<string> = new Set([
  'queued',
  'pending',
  'starting',
  'running',
  'planning',
  'awaiting_approval',
  'awaiting_gate',
  'verifying',
  'checkpointing',
  'deploying',
])

export function isLiveStatus(status: string | null | undefined): boolean {
  return typeof status === 'string' && LIVE_STATUSES.has(status.toLowerCase())
}

const TONES: Record<string, StatusTone> = {
  verified: 'green',
  merged: 'green',
  completed: 'green',
  success: 'green',
  deployed: 'green',
  error: 'rose',
  failed: 'rose',
  cancelled: 'neutral',
  canceled: 'neutral',
  running: 'accent',
  starting: 'accent',
  planning: 'accent',
  verifying: 'accent',
  checkpointing: 'accent',
  deploying: 'accent',
  queued: 'amber',
  pending: 'amber',
  blocked: 'amber',
  awaiting_approval: 'amber',
  awaiting_gate: 'amber',
}

export function statusTone(status: string | null | undefined): StatusTone {
  return TONES[(status ?? '').toLowerCase()] ?? 'neutral'
}

const LABELS: Record<string, string> = {
  awaiting_approval: 'Needs approval',
  awaiting_gate: 'Needs approval',
  checkpointing: 'Saving checkpoint',
  canceled: 'Cancelled',
}

const STEPPER_DONE = new Set(['verified', 'merged', 'deployed', 'completed', 'success'])
const STEPPER_VERIFY = new Set(['verifying', 'checkpointing', 'deploying'])
const STEPPER_FAILED = new Set(['error', 'failed', 'budget_exceeded', 'stalled', 'cancelled', 'canceled'])

/** Compact stage labels. Queued and awaiting approval are not shown as Building. */
export function statusStepper(status: string): { steps: string[]; current: number; failed: boolean } {
  const value = status.trim().toLowerCase()
  const failed = STEPPER_FAILED.has(value)
  if (value === 'queued') return { steps: ['Queued', 'Building', 'Verifying', 'Done'], current: 0, failed }
  if (value === 'awaiting_approval' || value === 'awaiting_gate') {
    return { steps: ['Needs approval', 'Building', 'Verifying', 'Done'], current: 0, failed }
  }
  const current = value === 'planning' ? 0
    : STEPPER_DONE.has(value) ? 3
    : STEPPER_VERIFY.has(value) ? 2
    : 1
  return { steps: ['Planning', 'Building', 'Verifying', 'Done'], current, failed }
}

/** Human label: "awaiting_approval" → "Needs approval", "running" → "Running". */
export function statusLabel(status: string | null | undefined): string {
  const value = (status ?? '').trim()
  if (!value) return 'Pending'
  const known = LABELS[value.toLowerCase()]
  if (known) return known
  const words = value.replace(/[_-]+/g, ' ').toLowerCase()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** What a builder action means in plain words. Shared by the run view's
 *  approval cards and the chat run card so one action reads one way. */
const GATE_ACTIONS: Record<string, string> = {
  apply_patch: 'Loop wants to change the project files',
  run_shell: 'Loop wants to run a command',
  deploy: 'Loop wants to publish this build',
  provision: 'Loop wants to set up a database table',
  request_secret: 'Loop needs a secret from you',
}

export function gateTitle(action: string | null | undefined): string {
  const key = (action ?? '').trim()
  return GATE_ACTIONS[key] ?? 'Loop needs your approval'
}

/** Date + time in the viewer's locale; passes unparseable input through. */
export function formatWhen(iso: string | null | undefined): string {
  if (!iso) return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}
