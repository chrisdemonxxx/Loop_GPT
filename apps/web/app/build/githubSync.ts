/** True when GitHub sync is a live provider, not the offline fake. */
export function githubSyncConnected(input: { mode?: string | null; provider?: string | null }): boolean {
  const provider = (input.provider ?? '').trim().toLowerCase()
  const mode = (input.mode ?? '').trim().toLowerCase()
  if (!provider || provider === 'fake') return false
  if (mode === 'fake') return false
  return true
}

/** `gitsync_provider` from engine health, when the payload includes it. */
export function gitsyncProvider(health: object | null | undefined): string | null {
  if (!health) return null
  const value = (health as { gitsync_provider?: unknown }).gitsync_provider
  return typeof value === 'string' && value.trim() ? value.trim() : null
}
