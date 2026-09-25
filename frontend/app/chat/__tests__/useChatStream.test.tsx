import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, act } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'

/** Streamed-text batching (audit §8-33): per-token delta/thinking callbacks
 * buffer and flush once per animation frame — the transcript (and its
 * Markdown parse) re-renders per frame, not per token. Terminal events and
 * the send() finally flush synchronously so no buffered text is ever lost
 * (background tabs where rAF stalls). */

const runAgentStreamMock = vi.hoisted(() => vi.fn())
vi.mock('../../lib/stream', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../lib/stream')>(),
  runAgentStream: runAgentStreamMock,
}))

import { useChatStream, type ChatStreamSendOptions } from '../hooks'
import type { StreamHandlers } from '../../lib/stream'

const base = {
  content: 'Hi', sendMode: 'agent' as const, attachmentIds: [], previews: [], docNames: [],
  runMode: 'auto' as const, modelTier: 'loop-large', incognito: false,
}

let captured: StreamHandlers
let release!: () => void
let gate!: Promise<void>

let latest: ReturnType<typeof useChatStream>
function Harness() {
  latest = useChatStream()
  const started = useRef(false)
  useEffect(() => {
    if (started.current) return
    started.current = true
    void latest.send({ ...base, ensureConversation: async () => 'conv-1' } as ChatStreamSendOptions)
  }, [])
  return (
    <div>
      <div data-testid="answer">{latest.liveAnswer || '(empty)'}</div>
      <div data-testid="thinking">{latest.liveThinking || '(none)'}</div>
    </div>
  )
}

function Providers() {
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false } } }))
  return (
    <QueryClientProvider client={client}>
      <Harness />
    </QueryClientProvider>
  )
}

beforeEach(() => {
  captured = undefined as unknown as StreamHandlers
  gate = new Promise<void>(r => { release = r })
  runAgentStreamMock.mockReset().mockImplementation(async (_cid, _body, handlers: StreamHandlers) => {
    captured = handlers
    await gate
  })
})
afterEach(() => { vi.unstubAllGlobals() })

describe('useChatStream streamed-text batching (§8-33)', () => {
  it('buffers per-token deltas and flushes once per frame', async () => {
    render(<Providers />)
    await waitFor(() => expect(captured).toBeTruthy())
    // 50 token callbacks, synchronously — all buffered, nothing rendered yet.
    act(() => {
      for (let i = 0; i < 50; i++) captured.onDelta!(0, `tok${i} `)
    })
    expect(screen.getByTestId('answer').textContent).toBe('(empty)')
    // One frame later: the whole batch rendered in a single state update.
    await act(async () => { await new Promise(r => setTimeout(r, 80)) })
    const answer = screen.getByTestId('answer').textContent
    expect(answer).toContain('tok0 ')
    expect(answer).toContain('tok49 ')
  })

  it('batches thinking deltas the same way', async () => {
    render(<Providers />)
    await waitFor(() => expect(captured).toBeTruthy())
    act(() => {
      for (let i = 0; i < 30; i++) captured.onThinking!(0, `th${i} `)
    })
    expect(screen.getByTestId('thinking').textContent).toBe('(none)')
    await act(async () => { await new Promise(r => setTimeout(r, 80)) })
    expect(screen.getByTestId('thinking').textContent).toContain('th29 ')
  })

  it('flushes buffered text synchronously at send completion even if rAF never fires', async () => {
    // Simulate a background tab: rAF is scheduled but never runs.
    vi.stubGlobal('requestAnimationFrame', () => 0)
    render(<Providers />)
    await waitFor(() => expect(captured).toBeTruthy())
    act(() => {
      for (let i = 0; i < 40; i++) captured.onDelta!(0, `tail${i} `)
    })
    expect(screen.getByTestId('answer').textContent).toBe('(empty)')
    // The stream ends (terminal): the finally's synchronous flush drains
    // the buffer — no token is lost without a frame.
    release()
    await act(async () => { await Promise.resolve() })
    await waitFor(() => expect(screen.getByTestId('answer').textContent).toContain('tail39 '))
  })

  it('deduplicates flush scheduling (safety net no-ops when a frame already flushed)', async () => {
    render(<Providers />)
    await waitFor(() => expect(captured).toBeTruthy())
    act(() => {
      captured.onDelta!(0, 'a')
      captured.onDelta!(0, 'b')
      captured.onDelta!(0, 'c')
    })
    await act(async () => { await new Promise(r => setTimeout(r, 80)) })
    expect(screen.getByTestId('answer').textContent).toBe('abc')
    // Idle: no pending buffers remain.
    await act(async () => { await new Promise(r => setTimeout(r, 300)) })
    expect(screen.getByTestId('answer').textContent).toBe('abc')
    release()
  })
})
