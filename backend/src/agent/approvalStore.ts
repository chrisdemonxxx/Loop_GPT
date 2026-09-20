/**
 * In-memory tool approval store. Keyed by (conversationId, toolName).
 * When a tool with needsApproval=true is called, the agent loop stores a
 * pending decision in this store and waits (polling with timeout). A POST
 * to /api/agent/:conversationId/approve resolves the decision and the
 * loop continues.
 *
 * Production: replace with a durable table if you need approval state to
 * survive server restarts mid-turn. For the current SSE stream model,
 * in-memory is correct — the stream dies on restart anyway.
 */

interface ApprovalEntry {
  toolName: string
  args: Record<string, any>
  approved: boolean | null
  resolvedAt: number | null
}

const store = new Map<string, ApprovalEntry>()

function key(conversationId: string, toolName: string): string {
  return `${conversationId}::${toolName}`
}

export function storeApproval(
  conversationId: string,
  toolName: string,
  args: Record<string, any>,
): void {
  store.set(key(conversationId, toolName), {
    toolName,
    args,
    approved: null,
    resolvedAt: null,
  })
}

export function resolveApproval(
  conversationId: string,
  toolName: string,
  approved: boolean,
): boolean {
  const entry = store.get(key(conversationId, toolName))
  if (!entry || entry.resolvedAt !== null) return false
  entry.approved = approved
  entry.resolvedAt = Date.now()
  return true
}

/** Poll for a decision with a bounded timeout. Returns true when approved,
 * false when denied, or throws on timeout/error. */
export async function waitForApproval(
  conversationId: string,
  toolName: string,
  timeoutMs = 120_000,
): Promise<boolean> {
  const k = key(conversationId, toolName)
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const entry = store.get(k)
    if (!entry) return false // Should not happen.
    if (entry.resolvedAt !== null) return entry.approved ?? false
    await new Promise((r) => setTimeout(r, 500))
  }
  // Timeout → treat as denied.
  store.delete(k)
  return false
}

export function clearApproval(conversationId: string): void {
  for (const k of store.keys()) {
    if (k.startsWith(conversationId + '::')) store.delete(k)
  }
}
