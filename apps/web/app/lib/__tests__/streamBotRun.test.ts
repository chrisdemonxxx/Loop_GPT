import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { streamBotRun } from '@loop/api-client'

/** Build a mock SSE Response from sequenced events. */
function sse(events: object[], opts?: { hang?: boolean }): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    start(controller) {
      for (const e of events) controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`))
      if (!opts?.hang) controller.close()
    },
  })
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('fetch', vi.fn())
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('streamBotRun reconnect + after cursor', () => {
  it('reconnects with ?after=<lastSeq> after a mid-stream drop', async () => {
    const urls: string[] = []
    ;(fetch as ReturnType<typeof vi.fn>).mockImplementation(async (url: string) => {
      urls.push(String(url))
      if (urls.length === 1) {
        // Drop after seq 2 — no terminal `done`.
        return sse([
          { type: 'status', message: 'booting', seq: 1 },
          { type: 'status', message: 'running', seq: 2 },
        ])
      }
      expect(String(url)).toContain('after=2')
      return sse([
        { type: 'final', content: 'ok', seq: 3 },
        { type: 'done', seq: 4 },
      ])
    })

    const events: string[] = []
    const onDone = vi.fn()
    const onError = vi.fn()
    streamBotRun(
      'run-reconnect',
      (e) => { events.push(e.type) },
      onDone,
      onError,
      { maxRetries: 3 },
    )

    await vi.advanceTimersByTimeAsync(0)
    await Promise.resolve()
    await Promise.resolve()
    // First stream closed → backoff before reconnect.
    await vi.advanceTimersByTimeAsync(1000)
    await Promise.resolve()
    await Promise.resolve()

    expect(urls.length).toBeGreaterThanOrEqual(2)
    expect(urls[1]).toContain('/api/bot/runs/run-reconnect/events?after=2')
    expect(events).toContain('done')
    expect(onDone).toHaveBeenCalled()
    expect(onError).not.toHaveBeenCalled()
  })

  it('retries 404 while the worker is still claiming, then surfaces', async () => {
    ;(fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(JSON.stringify({ error: 'Bot run not found' }), { status: 404 }),
    )
    const onError = vi.fn()
    streamBotRun('run-missing', () => {}, undefined, onError, { maxRetries: 1 })
    await vi.advanceTimersByTimeAsync(0)
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(1000)
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(2000)
    await Promise.resolve()
    expect(onError).toHaveBeenCalled()
  })
})
