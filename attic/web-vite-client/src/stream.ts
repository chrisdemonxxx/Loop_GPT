import { ClientError, filePath, record, resourceId, text } from './security'

export interface Artifact { id: string; name: string }
export type StreamEvent =
  | { type: 'conversation'; id: string }
  | { type: 'status' | 'warming' | 'tool_call' | 'tool_result' }
  | { type: 'delta'; text: string; step: number }
  | { type: 'final'; content: string }
  | { type: 'artifact'; artifact: Artifact }
  | { type: 'error' | 'done' }

export function parseEvent(data: string): StreamEvent | null {
  let raw: unknown
  try { raw = JSON.parse(data) } catch { throw new ClientError('protocol') }
  const event = record(raw)
  switch (event.type) {
    case 'status': {
      const message = text(event.message)
      return message.startsWith('conversation:')
        ? { type: 'conversation', id: resourceId(message.slice(13)) }
        : { type: 'status' }
    }
    case 'delta':
      if (!Number.isSafeInteger(event.step) || (event.step as number) < 0) throw new ClientError('protocol')
      return { type: 'delta', step: event.step as number, text: text(event.text) }
    case 'final': return { type: 'final', content: text(event.content) }
    case 'artifact': {
      const artifact = record(event.artifact)
      const id = text(artifact.id, 160)
      filePath(id) // Ignore model-supplied URLs; downloads use validated IDs only.
      return { type: 'artifact', artifact: { id, name: text(artifact.name, 500) } }
    }
    case 'warming': case 'tool_call': case 'tool_result': case 'error': case 'done':
      return { type: event.type }
    default: return null // Forward-compatible unknown event types, never rendered as HTML.
  }
}

// Incremental SSE framing: CR, LF, CRLF, multi-line data, comments, UTF-8 via decoder below.
export class SSEParser {
  private line = ''
  private data: string[] = []
  private size = 0
  private afterCR = false
  constructor(private readonly emit: (data: string) => void, private readonly maxFrame = 2_000_000) {}
  push(chunk: string) {
    for (const char of chunk) {
      if (this.afterCR && char === '\n') { this.afterCR = false; continue }
      this.afterCR = false
      if (char === '\r' || char === '\n') {
        this.consumeLine()
        this.afterCR = char === '\r'
      } else {
        this.line += char
        if (++this.size > this.maxFrame) throw new ClientError('tooLarge')
      }
    }
  }
  private consumeLine() {
    if (this.line === '') {
      if (this.data.length) this.emit(this.data.join('\n'))
      this.data = []
      this.size = 0
    } else if (this.line === 'data' || this.line.startsWith('data:')) {
      this.data.push(this.line.slice(5).replace(/^ /, ''))
    }
    this.line = ''
  }
  finish() {
    // An unterminated event is not a complete SSE message.
    if (this.line || this.data.length) throw new ClientError('protocol')
  }
}

export async function consumeStream(response: Response, signal: AbortSignal, emit: (event: StreamEvent) => void) {
  if (!response.headers.get('content-type')?.toLowerCase().startsWith('text/event-stream') || !response.body) {
    await response.body?.cancel()
    throw new ClientError('protocol')
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let done = false
  let final = false
  let failed = false
  let total = 0
  const parser = new SSEParser((data) => {
    if (done) return
    const event = parseEvent(data)
    if (!event) return
    if (event.type === 'final') final = true
    if (event.type === 'error') failed = true
    if (event.type === 'done') {
      if (!final && !failed) throw new ClientError('protocol')
      done = true
    }
    emit(event)
  })
  const cancel = () => { void reader.cancel().catch(() => {}) }
  signal.addEventListener('abort', cancel, { once: true })
  try {
    signal.throwIfAborted()
    while (!done) {
      const chunk = await reader.read()
      signal.throwIfAborted()
      if (chunk.done) {
        parser.push(decoder.decode())
        parser.finish()
        if (!done) throw new ClientError('protocol')
        break
      }
      total += chunk.value.byteLength
      if (total > 8 * 1024 * 1024) throw new ClientError('tooLarge')
      parser.push(decoder.decode(chunk.value, { stream: true }))
    }
    if (failed) throw new ClientError('http', 502)
  } finally {
    signal.removeEventListener('abort', cancel)
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

export interface Reply { content: string; step?: number; artifacts: Artifact[] }
export function applyEvent(reply: Reply, event: StreamEvent): Reply {
  if (event.type === 'delta') {
    const content = (reply.step === undefined || reply.step === event.step ? reply.content : '') + event.text
    if (content.length > 1_000_000) throw new ClientError('tooLarge')
    return { ...reply, step: event.step, content }
  }
  if (event.type === 'final') return { ...reply, content: event.content }
  if (event.type === 'artifact') {
    if (reply.artifacts.some((item) => item.id === event.artifact.id)) return reply
    if (reply.artifacts.length >= 100) throw new ClientError('tooLarge')
    return { ...reply, artifacts: [...reply.artifacts, event.artifact] }
  }
  return reply
}
