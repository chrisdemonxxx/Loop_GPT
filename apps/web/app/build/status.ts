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

/** Human label: "awaiting_approval" → "Needs approval", "running" → "Running". */
export function statusLabel(status: string | null | undefined): string {
  const value = (status ?? '').trim()
  if (!value) return 'Pending'
  const known = LABELS[value.toLowerCase()]
  if (known) return known
  const words = value.replace(/[_-]+/g, ' ').toLowerCase()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** Date + time in the viewer's locale; passes unparseable input through. */
export function formatWhen(iso: string | null | undefined): string {
  if (!iso) return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}
