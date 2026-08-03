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
  onToolCall?: (step: number, name: string, args: any, source?: string) => void
  onToolResult?: (step: number, name: string, content: string, data: any, isError?: boolean) => void
  onArtifact?: (artifact: ArtifactRef) => void
  onFinal?: (content: string, metadata: any) => void
  onError?: (message: string) => void
  onDone?: () => void
}

export interface StreamBody {
  content: string
  imagePath?: string
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
  const res = await fetch(`${API_URL}/api/conversations/${conversationId}/stream`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(body),
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
    case 'tool_call':
      h.onToolCall?.(event.step, event.name, event.args, event.source)
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
