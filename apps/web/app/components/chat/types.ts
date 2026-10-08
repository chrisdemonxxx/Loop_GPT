/** Shared chat-domain types (message + conversation rows as served by the API). */
export interface Message {
  id: string
  role: 'user' | 'assistant'
  content: string
  createdAt: string
  messageType?: string
  imageUrl?: string
  attachmentId?: string
  toolUsed?: string
  metadata?: any
  /** Branch tree (§8-22): the row this message follows in its branch.
   *  Versions of a turn (retries / edits) share the same parentId. */
  parentId?: string | null
  /** Set when an assistant row was written by a named bot. */
  authorBotId?: string | null
}

export interface Conversation {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  /** Pinned to the top of the sidebar (audit §8-13). */
  pinned?: boolean
  /** chat (default), bot (one named agent), or group (several bots). */
  kind?: string
  botId?: string | null
  botIds?: string[]
  /** Loop-IT build started from this conversation. */
  loopitRunId?: string | null
}

/** One streamed agent step (tool call or text delta group) in the live turn. */
export interface LiveStep {
  index: number
  kind: 'text' | 'tool'
  text: string
  ts?: number
  tool?: {
    name: string
    args: any
    source?: string
    result?: string
    isError?: boolean
    /** Wall time from call start to result (set when the result lands). */
    durationMs?: number
    /** Live stdout/stderr while the tool runs (§8-28) — bounded display buffer. */
    liveOutput?: { stdout: string; stderr: string }
    /** Progress checklist while the tool runs (§8-29); latest wins. */
    progress?: Array<{ id: string; label: string; status: 'pending' | 'active' | 'done' | 'error' }>
    /** Names of artifacts this step produced (§8-28 "View in panel"). */
    artifacts?: string[]
  }
}

/** A persisted tool step from an assistant message's metadata.steps. */
export interface StoredStep {
  tool: string
  args?: Record<string, any>
  result?: string
  /** Names of artifacts this step produced, if any (§8-28). */
  artifacts?: string[]
}

/** Pending tool-approval handshake for the live turn. */
export interface PendingApproval {
  toolName: string
  /** Server id required by POST /api/agent/:conversationId/approve. */
  approvalId?: string
  /** Extra line for the approval card, such as a Loop-IT gate reason. */
  detail?: string
  approve: (ok: boolean, approvalId?: string) => Promise<any>
}

/** A message queued behind the active run (audit §8-39): the full send
 *  intent is snapshotted at enqueue time and auto-dispatched when the run
 *  completes. Never silently dropped. */
export interface QueuedMessage {
  id: string
  content: string
  /** Pre-uploaded server attachment ids + local previews captured at enqueue. */
  attachmentIds: string[]
  previews: string[]
  docNames: string[]
  sendMode: import('../../lib/api').AgentMode
  commandTools?: string[]
  /** Run config captured at enqueue — the queued message carries its full
   *  intent; later toggles don't rewrite what was already queued. */
  runMode: 'auto' | 'plan' | 'accept' | 'step'
  modelTier: string
  selectedTools?: Set<string> | null
  incognito: boolean
  projectId?: string
  webSearch?: 'auto' | 'on' | 'off'
  /** Effort union (contract §A, rank 7): the 6 composer positions —
   *  auto = server default, low/medium/high/xhigh, off = no CoT. */
  thinking?: 'auto' | 'low' | 'medium' | 'high' | 'xhigh' | 'off'
  /** Pinned workspace connections (§8-40): their tools join this agent run. */
  connectionIds?: string[]
  /** §8-22: pending-branch parent, if the queued message was an edit. */
  branchParent?: string | null
  /** Named bot this queued turn should run as. */
  botId?: string
  /** Group fan-out: skip saving another copy of the user message. */
  skipUserPersist?: boolean
}
