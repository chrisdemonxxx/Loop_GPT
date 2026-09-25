import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runAgentStream } from '../stream'
import { API_URL } from '../api'

/** Stream auto-resume (audit §8-30): a dropped SSE connection mid-run
 * reconnects to GET /runs/:runId/events?after=<lastSeq> with backoff, replays
 * the missed sequenced events, and finishes the SAME run — no manual re-send.
 * 404s (expired runs) give up with an error; user aborts never resume. */

/** Build a mock SSE Response from sequenced events. */
function sse(events: any[]): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    start(controller) {
      for (const e of events) controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`))
      controller.close()
    },
  })
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
}

const base = { content: 'Hi', mode: 'agent' }

beforeEach(() => { vi.stubGlobal('fetch', vi.fn()) })
afterEach(() => { vi.unstubAllGlobals() })

describe('runAgentStream auto-resume', () => {
  it('resumes a mid-run drop and completes the same run', async () => {
    const calls: string[] = []
    ;(fetch as any).mockImplementation(async (url: any, init?: any) => {
      calls.push(String(url) + (init?.method === 'POST' ? ' POST' : ' GET'))
      if (String(url).endsWith('/stream')) {
        // Drops mid-run: run + one delta, no terminal event.
        return sse([
          { type: 'run', runId: 'run-1', seq: 0 },
          { type: 'delta', step: 0, text: 'part one ', seq: 1 },
        ])
      }
      expect(String(url)).toContain('/runs/run-1/events')
      expect(String(url)).toContain('after=1') // resumes strictly after the last received seq
      return sse([
        { type: 'delta', step: 0, text: 'part two', seq: 2 },
        { type: 'final', content: 'part one part two', metadata: {}, seq: 3 },
        { type: 'done', seq: 4 },
      ])
    })
    const onDelta = vi.fn()
    const onFinal = vi.fn()
    const onDone = vi.fn()
    const onError = vi.fn()
    const onRun = vi.fn()
    await runAgentStream('c1', base, { onDelta, onFinal, onDone, onError, onRun })
    expect(onRun).toHaveBeenCalledWith('run-1')
    expect(onDelta.mock.calls.map((c) => c[1])).toEqual(['part one ', 'part two'])
    expect(onFinal).toHaveBeenCalledWith('part one part two', {})
    expect(onDone).toHaveBeenCalled()
    expect(onError).not.toHaveBeenCalled()
    expect(calls[0]).toContain('/stream')
    expect(calls[1]).toContain('/runs/run-1/events')
  })

  it('gives up with an error when the run is no longer resumable (404)', async () => {
    ;(fetch as any).mockImplementation(async (url: any, init?: any) => {
      if (String(url).endsWith('/stream')) {
        return sse([{ type: 'run', runId: 'run-2', seq: 0 }])
      }
      return new Response(JSON.stringify({ error: 'gone' }), { status: 404 })
    })
    const onError = vi.fn()
    const onDone = vi.fn()
    await runAgentStream('c1', base, { onError, onDone })
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls[0][0]).toMatch(/no longer resumable/i)
  })

  it('never resumes after a clean terminal event', async () => {
    ;(fetch as any).mockImplementation(async () =>
      sse([
        { type: 'run', runId: 'run-3', seq: 0 },
        { type: 'final', content: 'done cleanly', seq: 1 },
        { type: 'done', seq: 2 },
      ]))
    const onFinal = vi.fn()
    await runAgentStream('c1', base, { onFinal })
    expect(onFinal).toHaveBeenCalledWith('done cleanly', undefined)
    expect((fetch as any).mock.calls).toHaveLength(1) // no resume GET
  })

  it('never resumes after a user abort (the stop button cancels instead)', async () => {
    const controller = new AbortController()
    ;(fetch as any).mockImplementation(async () =>
      sse([{ type: 'run', runId: 'run-4', seq: 0 }, { type: 'delta', step: 0, text: 'x', seq: 1 }]))
    controller.abort() // user hits stop as the run streams
    const onError = vi.fn()
    await runAgentStream('c1', base, { onError }, controller.signal)
    expect((fetch as any).mock.calls.filter((c: any[]) => String(c[0]).includes('/runs/'))).toHaveLength(0)
    expect(onError).not.toHaveBeenCalled()
  })
})
