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
}

export interface Conversation {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  /** Pinned to the top of the sidebar (audit §8-13). */
  pinned?: boolean
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
  approve: (ok: boolean) => Promise<any>
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
  thinking?: 'auto' | 'on' | 'off'
  /** §8-22: pending-branch parent, if the queued message was an edit. */
  branchParent?: string | null
}
