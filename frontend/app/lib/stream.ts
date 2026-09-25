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
  /** The run id reported by the server — the auto-resume handle (§8-30). */
  onRun?: (runId: string) => void
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
  /** Web-search override (§8-25): true forces web tools in, false strips them. */
  webSearch?: boolean
  /** Extended-thinking override (§8-26): per-run CoT switch. */
  thinking?: boolean
  mode?: string
  provider?: string
  model?: string
  apiKey?: string
}

/**
 * POST to the SSE streaming endpoint and dispatch parsed events to handlers.
 * Returns the conversation id reported by the server (for new chats).
 *
 * Auto-resume (audit §8-30): the server's runs are durable — every event is
 * sequenced and buffered per run. If the SSE connection drops mid-turn
 * (network blip, proxy idle-kill) WITHOUT a terminal event, this client
 * reconnects via GET /runs/:runId/events?after=<lastSeq> with backoff and
 * continues the SAME run — no manual re-send, no double model charge. An
 * explicit user abort (the stop button) cancels the run server-side instead.
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
  const safeBody: { content: string; mode: string; attachmentId?: string; attachmentIds?: string[]; toolNames?: string[]; autoApprove?: boolean; stepMode?: boolean; incognito?: boolean; projectId?: string; model?: string; webSearch?: boolean; thinking?: boolean } = {
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
  // Explicit per-run capability overrides (§8-25/26): only present when
  // the user chose them (undefined = server default).
  if (body.webSearch !== undefined) safeBody.webSearch = body.webSearch
  if (body.thinking !== undefined) safeBody.thinking = body.thinking
  // Hosted model tier selection (the server rejects provider/apiKey/baseUrl).
  if (body.model) safeBody.model = body.model

  // ── Resume bookkeeping ─────────────────────────────────────────────────
  let runId = ''
  let lastSeq = -1
  let sawTerminal = false // final | done | error received
  const track = (event: any) => {
    if (typeof event.seq === 'number' && event.seq > lastSeq) lastSeq = event.seq
    if (event.type === 'run' && typeof event.runId === 'string') runId = event.runId
    if (event.type === 'final' || event.type === 'done' || event.type === 'error') sawTerminal = true
  }
  const wrapped: StreamHandlers = {
    ...handlers,
    onRun: (id) => { runId = id; handlers.onRun?.(id) },
    onFinal: (content, metadata) => { sawTerminal = true; handlers.onFinal?.(content, metadata) },
    onError: (message) => { sawTerminal = true; handlers.onError?.(message) },
    onDone: () => { sawTerminal = true; handlers.onDone?.() },
  }

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
      wrapped.onError?.(parsed?.error || "You're out of credits for today. Redeem a voucher or upgrade in Account.")
    } else {
      wrapped.onError?.(parsed?.error || `Request failed (${res.status}). ${text.slice(0, 200)}`)
    }
    return
  }

  await readSse(res, track, wrapped, signal)

  // ── Auto-resume: the stream ended WITHOUT a terminal event and WITHOUT a
  // user abort → reconnect to the durable run (§8-30).
  const backoff = [1000, 2000, 4000, 8000, 16_000, 30_000]
  for (const delay of backoff) {
    if (signal?.aborted) return
    if (sawTerminal) return
    if (!runId) break // dropped before the run id arrived — nothing to resume
    await new Promise((r) => setTimeout(r, delay))
    if (signal?.aborted || sawTerminal) return
    let resumed: Response
    try {
      resumed = await fetch(`${API_URL}/api/agent/${conversationId}/runs/${runId}/events?after=${Math.max(lastSeq, 0)}`, {
        headers: authHeaders(),
        signal,
      })
    } catch {
      continue // still offline — keep backing off
    }
    if (!resumed.ok || !resumed.body) {
      if (resumed.status === 404 || resumed.status === 410) {
        // The run expired or the process restarted: nothing to resume into.
        wrapped.onError?.('Connection lost — this run is no longer resumable. Your message may still complete in the background.')
        return
      }
      continue
    }
    await readSse(resumed, track, wrapped, signal)
    if (sawTerminal) return
  }

  if (!sawTerminal && !signal?.aborted) {
    wrapped.onError?.('Connection lost mid-run. It may still complete in the background — check back in a moment.')
  }
}

/** Read one SSE response to its end, dispatching sequenced events. */
async function readSse(
  res: Response,
  track: (event: any) => void,
  handlers: StreamHandlers,
  signal?: AbortSignal
): Promise<void> {
  if (!res.body) return
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  while (true) {
    if (signal?.aborted) {
      try { await reader.cancel() } catch { /* already closed */ }
      return
    }
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
      track(event)
      dispatch(event, handlers)
    }
  }
}

function dispatch(event: any, h: StreamHandlers) {
  switch (event.type) {
    case 'status':
      h.onStatus?.(event.message)
      break
    case 'run':
      h.onRun?.(event.runId)
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
