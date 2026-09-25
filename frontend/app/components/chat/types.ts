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
  }
}

/** A persisted tool step from an assistant message's metadata.steps. */
export interface StoredStep {
  tool: string
  args?: Record<string, any>
  result?: string
}

/** Pending tool-approval handshake for the live turn. */
export interface PendingApproval {
  toolName: string
  approve: (ok: boolean) => Promise<any>
}
