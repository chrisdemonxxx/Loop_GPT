import { API_URL, authHeaders } from './api'

export interface ArtifactRef {
  id: string
  kind: string
  name: string
  url?: string
  mimeType?: string
}

/** A single visible step in an agent run (one model turn or tool call). */
export interface AgentStep {
  index: number
  kind: 'thinking' | 'tool' | 'answer'
  text: string
  tool?: { name: string; args: any; source?: string; result?: string; isError?: boolean; data?: any }
}

export interface StreamHandlers {
  onStatus?: (message: string) => void
  onWarming?: (message: string) => void
  onDelta?: (step: number, text: string) => void
  onThinking?: (step: number, text: string) => void
  onToolCall?: (step: number, name: string, args: any, source?: string) => void
  onToolResult?: (step: number, name: string, content: string, data: any, isError?: boolean) => void
  onArtifact?: (artifact: ArtifactRef) => void
  onPendingApproval?: (tool_name: string, args: any, prompt: string) => void
  onFinal?: (content: string, metadata: any) => void
  onError?: (message: string) => void
  onDone?: () => void
}

export interface StreamBody {
  content: string
  attachmentId?: string
  attachmentIds?: string[]
  toolNames?: string[]
  autoApprove?: boolean
  /** "Ask first": pause for approval before every tool call. */
  stepMode?: boolean
  /** Incognito: no sidebar entry, no memory read/write, excluded from synthesis. */
  incognito?: boolean
  projectId?: string
  mode?: string
  provider?: string
  model?: string
  apiKey?: string
}

/**
 * POST to the SSE streaming endpoint and dispatch parsed events to handlers.
 * Returns the conversation id reported by the server (for new chats).
 */
export async function runAgentStream(
  conversationId: string,
  body: StreamBody,
  handlers: StreamHandlers,
  signal?: AbortSignal
): Promise<void> {
  // LOCAL PREVIEW ADAPTATION: the hardened backend serves the SSE stream at
  // /api/agent/:id/stream and rejects BYOK fields (provider/model/apiKey) and
  // server file paths (imagePath). Send only the hosted contract, including the
  // attachmentId so image attachments actually reach the vision path.
  const safeBody: { content: string; mode: string; attachmentId?: string; attachmentIds?: string[]; toolNames?: string[]; autoApprove?: boolean; stepMode?: boolean; incognito?: boolean; projectId?: string; model?: string } = {
    content: body.content,
    mode: body.mode || 'chat',
  }
  if (body.attachmentId) safeBody.attachmentId = body.attachmentId
  if (body.attachmentIds?.length) safeBody.attachmentIds = body.attachmentIds
  // Per-chat tool selection + run mode ("Accept edits" auto-approves;
  // "Ask first" pauses before every tool call; incognito skips memory).
  if (body.toolNames?.length) safeBody.toolNames = body.toolNames
  if (body.autoApprove) safeBody.autoApprove = true
  if (body.stepMode) safeBody.stepMode = true
  if (body.incognito) safeBody.incognito = true
  if (body.projectId) safeBody.projectId = body.projectId
  // Hosted model tier selection (the server rejects provider/apiKey/baseUrl).
  if (body.model) safeBody.model = body.model
  const res = await fetch(`${API_URL}/api/agent/${conversationId}/stream`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(safeBody),
    signal,
  })
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '')
    let parsed: any = null
    try {
      parsed = JSON.parse(text)
    } catch {
      /* not JSON */
    }
    if (res.status === 402 || parsed?.code === 'OUT_OF_CREDITS') {
      handlers.onError?.(parsed?.error || "You're out of credits for today. Redeem a voucher or upgrade in Account.")
    } else {
      handlers.onError?.(parsed?.error || `Request failed (${res.status}). ${text.slice(0, 200)}`)
    }
    return
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const parts = buffer.split('\n\n')
    buffer = parts.pop() || ''
    for (const part of parts) {
      const line = part.split('\n').find((l) => l.startsWith('data:'))
      if (!line) continue
      const payload = line.slice(5).trim()
      if (!payload || payload.startsWith(':')) continue
      let event: any
      try {
        event = JSON.parse(payload)
      } catch {
        continue
      }
      dispatch(event, handlers)
    }
  }
  handlers.onDone?.()
}

function dispatch(event: any, h: StreamHandlers) {
  switch (event.type) {
    case 'status':
      h.onStatus?.(event.message)
      break
    case 'warming':
      h.onWarming?.(event.message)
      break
    case 'delta':
      h.onDelta?.(event.step, event.text)
      break
    case 'thinking':
      h.onThinking?.(event.step, event.text)
      break
    case 'tool_call':
      h.onToolCall?.(event.step, event.name, event.args, event.source)
      break
    case 'pending_approval':
      h.onPendingApproval?.(event.tool_name, event.args, event.prompt)
      break
    case 'tool_result':
      h.onToolResult?.(event.step, event.name, event.content, event.data, event.isError)
      break
    case 'artifact':
      h.onArtifact?.(event.artifact)
      break
    case 'final':
      h.onFinal?.(event.content, event.metadata)
      break
    case 'error':
      h.onError?.(event.message)
      break
    case 'done':
      h.onDone?.()
      break
  }
}
