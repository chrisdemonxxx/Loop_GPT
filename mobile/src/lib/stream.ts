/**
 * POST SSE streaming for React Native. RN's fetch does not expose streaming
 * bodies, so this uses XHR onprogress with incremental line parsing — the
 * same event vocabulary as the web client (status / delta.text / final.content
 * / error.message / done) and the same hardened contract:
 * POST /api/agent/:conversationId/stream with { content, mode } only.
 */
import { API_URL, ApiError, getToken } from './api'

export type AgentMode = 'chat' | 'agent' | 'research'
export interface StreamHandlers {
  onStatus?: (message: string) => void
  onDelta?: (text: string) => void
  onThinking?: (text: string) => void
  onFinal?: (content: string) => void
  onError?: (message: string) => void
  onDone?: () => void
}

/** Run mode parity with the web composer (§7a). */
export type RunMode = 'auto' | 'plan' | 'step' | 'accept'

export function parseCommand(input: string): { mode: AgentMode; text: string } {
  const m = input.match(/^\/(research|chat|agent)\b[ \t]*/i)
  if (m) {
    const c = m[1].toLowerCase()
    return { mode: c === 'research' ? 'research' : c === 'chat' ? 'chat' : 'agent', text: input.slice(m[0].length) }
  }
  return { mode: 'agent', text: input }
}

export function runAgentStream(conversationId: string, body: {
  content: string; mode: AgentMode; runMode?: RunMode
}, handlers: StreamHandlers): { cancel: () => void } {
  const xhr = new XMLHttpRequest()
  let consumed = 0
  let buffer = ''
  xhr.open('POST', `${API_URL}/api/agent/${conversationId}/stream`)
  xhr.setRequestHeader('Content-Type', 'application/json')
  const token = getToken()
  if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`)
  const runMode = body.runMode || 'auto'
  const payload = {
    content: body.content,
    mode: body.mode,
    ...(runMode === 'accept' ? { autoApprove: true } : {}),
    ...(runMode === 'step' ? { stepMode: true } : {}),
  }
  xhr.onprogress = () => {
    const chunk = xhr.responseText.slice(consumed)
    consumed = xhr.responseText.length
    buffer += chunk
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.startsWith('data:')) continue
      const data = line.slice(5).trim()
      if (!data) continue
      if (data === '[DONE]') { handlers.onDone?.(); return }
      try {
        const ev = JSON.parse(data)
        if (ev.type === 'status' && typeof ev.message === 'string') handlers.onStatus?.(ev.message)
        else if (ev.type === 'delta' && typeof ev.text === 'string') handlers.onDelta?.(ev.text)
        else if (ev.type === 'thinking' && typeof ev.text === 'string') handlers.onThinking?.(ev.text)
        else if (ev.type === 'final' && typeof ev.content === 'string') handlers.onFinal?.(ev.content)
        else if (ev.type === 'error' && typeof ev.message === 'string') handlers.onError?.(ev.message)
        else if (ev.type === 'done') handlers.onDone?.()
      } catch { /* partial JSON stays buffered until a full line arrives */ }
    }
  }
  xhr.onload = () => {
    if (xhr.status === 401) { handlers.onError?.('Session expired. Sign in again.'); return }
    if (xhr.status >= 400) {
      let message = `Request failed (${xhr.status})`
      try { const b = JSON.parse(xhr.responseText); if (b?.error?.message) message = b.error.message } catch {}
      handlers.onError?.(message)
      return
    }
    handlers.onDone?.()
  }
  xhr.onerror = () => handlers.onError?.('Network error. Check your connection.')
  xhr.send(JSON.stringify(payload))
  return { cancel: () => xhr.abort() }
}
