import { describe, expect, it } from 'vitest'
import { applyEvent, consumeStream, parseEvent, SSEParser, type StreamEvent } from '../src/stream'

function response(data: string, step = 1) {
  const bytes = new TextEncoder().encode(data)
  return new Response(new ReadableStream({ start(controller) {
    for (let index = 0; index < bytes.length; index += step) controller.enqueue(bytes.slice(index, index + step))
    controller.close()
  } }), { headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } })
}
const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`
describe('backend SSE contract', () => {
  it.each(['\n', '\r\n', '\r'])('handles %j newlines split at every character, comments and multiline data', (newline) => {
    const events: string[] = []
    const parser = new SSEParser((data) => events.push(data))
    const input = [': connected', '', 'event: ignored', 'data: {"type":', 'data: "done"}', '', ''].join(newline)
    for (const char of input) parser.push(char)
    parser.finish()
    expect(events).toEqual(['{"type":\n"done"}'])
  })
  it('decodes split UTF-8 and uses final as authoritative replacement', async () => {
    const events: StreamEvent[] = []
    await consumeStream(response(': connected\n\n' + frame({ type: 'status', message: 'conversation:personal-test' }) +
      frame({ type: 'delta', step: 0, text: 'Allô 🌿' }) + frame({ type: 'final', content: 'Final 🌿' }) + frame({ type: 'done' })),
    new AbortController().signal, (event) => events.push(event))
    expect(events[0]).toEqual({ type: 'conversation', id: 'personal-test' })
    const reply = events.reduce(applyEvent, { content: '', artifacts: [] })
    expect(reply.content).toBe('Final 🌿')
  })
  it('resets intermediate tool-step text and replaces it with final', () => {
    let reply = applyEvent({ content: '', artifacts: [] }, { type: 'delta', step: 1, text: 'Thinking' })
    reply = applyEvent(reply, { type: 'delta', step: 2, text: 'Answer' })
    reply = applyEvent(reply, { type: 'delta', step: 2, text: ' continues' })
    expect(reply.content).toBe('Answer continues')
    expect(applyEvent(reply, { type: 'final', content: 'Authoritative' }).content).toBe('Authoritative')
  })
  it.each([
    '', frame({ type: 'delta', step: 0, text: 'partial' }), frame({ type: 'final', content: 'lost terminator' }),
    frame({ type: 'done' }), 'data: {"type":"done"}', 'data: broken\n\n',
  ])('rejects truncated/malformed or false-success streams (%j)', async (body) => {
    await expect(consumeStream(response(body), new AbortController().signal, () => {})).rejects.toThrow()
  })
  it('surfaces errors even when the backend subsequently emits done', async () => {
    const events: StreamEvent[] = []
    await expect(consumeStream(response(frame({ type: 'error', message: 'private details' }) + frame({ type: 'done' })),
      new AbortController().signal, (event) => events.push(event))).rejects.toMatchObject({ status: 502 })
    expect(events).toEqual([{ type: 'error' }, { type: 'done' }])
  })
  it('cancels a stalled reader on abort and releases the lock', async () => {
    let cancelled = false
    const body = new ReadableStream({ cancel() { cancelled = true } })
    const controller = new AbortController()
    const run = consumeStream(new Response(body, { headers: { 'content-type': 'text/event-stream' } }), controller.signal, () => {})
    controller.abort()
    await expect(run).rejects.toMatchObject({ name: 'AbortError' })
    expect(cancelled).toBe(true)
    expect(body.locked).toBe(false)
  })
  it('rejects non-SSE and invalid UTF-8', async () => {
    await expect(consumeStream(new Response('<html>'), new AbortController().signal, () => {})).rejects.toThrow()
    await expect(consumeStream(new Response(new Uint8Array([255]), { headers: { 'content-type': 'text/event-stream' } }),
      new AbortController().signal, () => {})).rejects.toThrow()
  })
  it('bounds frames and accumulated response text', () => {
    const parser = new SSEParser(() => {}, 20)
    expect(() => parser.push('data: ' + 'x'.repeat(21))).toThrow('tooLarge')
    expect(() => applyEvent({ content: 'x'.repeat(1_000_000), artifacts: [] }, { type: 'delta', step: 0, text: 'x' })).toThrow('tooLarge')
  })
  it('ignores future events and strips executable URLs from artifacts', () => {
    expect(parseEvent('{"type":"future","html":"<script>"}')).toBe(null)
    const id = '12345678-1234-1234-1234-123456789abc'
    const event = parseEvent(JSON.stringify({ type: 'artifact', artifact: { id, name: 'test.html', url: 'https://attacker.invalid/steal' } }))!
    expect(event).toEqual({ type: 'artifact', artifact: { id, name: 'test.html' } })
    const reply = applyEvent({ content: '', artifacts: [] }, event)
    expect(applyEvent(reply, event).artifacts).toHaveLength(1)
  })
  it.each([
    { type: 'delta', text: 3, step: 0 }, { type: 'delta', text: 'x', step: -1 },
    { type: 'final', content: {} }, { type: 'artifact', artifact: { id: '../secret', name: 'x' } },
    { type: 'status', message: 'conversation:../../elsewhere' }, null,
  ])('rejects invalid known event fields: %j', (event) => {
    expect(() => parseEvent(JSON.stringify(event))).toThrow()
  })
})
