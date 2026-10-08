/**
 * In-memory tool approval store. Each pending decision has a random id and is
 * bound to the user, conversation and tool that raised it. The agent loop
 * stores a pending decision and waits (polling with timeout). A POST to
 * /api/agent/:conversationId/approve from the SAME user resolves it and the
 * loop continues; another account can never resolve someone else's approval.
 *
 * Production: replace with a durable table if you need approval state to
 * survive server restarts mid-turn. For the current SSE stream model,
 * in-memory is correct — the stream dies on restart anyway.
 */
import { randomUUID } from 'crypto'

interface ApprovalEntry {
  id: string
  userId: string
  conversationId: string
  toolName: string
  args: Record<string, any>
  approved: boolean | null
  resolvedAt: number | null
  createdAt: number
}

const PENDING_TTL_MS = 130_000
const RESOLVED_TTL_MS = 30_000

const store = new Map<string, ApprovalEntry>()

function sweep(now = Date.now()) {
  for (const [k, entry] of store) {
    if (entry.resolvedAt !== null && now - entry.resolvedAt > RESOLVED_TTL_MS) store.delete(k)
    else if (entry.resolvedAt === null && now - entry.createdAt > PENDING_TTL_MS) store.delete(k)
  }
}

/** Register a pending decision and return its id (sent to the client). */
export function storeApproval(
  userId: string,
  conversationId: string,
  toolName: string,
  args: Record<string, any>,
): string {
  sweep()
  const id = randomUUID()
  store.set(id, { id, userId, conversationId, toolName, args, approved: null, resolvedAt: null, createdAt: Date.now() })
  return id
}

/** Resolve a pending decision owned by `userId`. With an approvalId the match
 * is exact; without one (older clients) it must be the only pending approval
 * for that tool in the conversation. */
export function resolveApproval(
  userId: string,
  conversationId: string,
  toolName: string,
  approved: boolean,
  approvalId?: string,
): boolean {
  sweep()
  if (!userId) return false
  const matches = [...store.values()].filter((e) =>
    e.resolvedAt === null && e.userId === userId && e.conversationId === conversationId && e.toolName === toolName
    && (approvalId === undefined || e.id === approvalId))
  if (matches.length !== 1) return false
  matches[0].approved = approved
  matches[0].resolvedAt = Date.now()
  return true
}

/** Poll for a decision with a bounded timeout. Returns true when approved,
 * false when denied, missing or timed out. */
export async function waitForApproval(approvalId: string, timeoutMs = 120_000, signal?: AbortSignal): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (signal?.aborted) {
      store.delete(approvalId)
      return false
    }
    sweep()
    const entry = store.get(approvalId)
    if (!entry) return false
    if (entry.resolvedAt !== null) {
      store.delete(approvalId)
      return entry.approved ?? false
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  // Timeout → treat as denied.
  store.delete(approvalId)
  return false
}

export function clearApproval(conversationId: string, userId?: string): void {
  for (const [k, entry] of store) {
    if (entry.conversationId === conversationId && (userId === undefined || entry.userId === userId)) store.delete(k)
  }
}
