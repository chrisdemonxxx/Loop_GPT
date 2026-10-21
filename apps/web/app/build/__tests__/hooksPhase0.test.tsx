import type { ReactNode } from 'react'
import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parsePreviewExpiresAt, parseSseChunk, PREVIEW_TTL_SECONDS } from '@loop/loopit-client'
import { previewRefreshDelayMs, useGatesEnabled, usePreviewUrl, useRunStream } from '../hooks'

const client = vi.hoisted(() => ({
  createPreviewUrl: vi.fn(),
  streamRunEvents: vi.fn(),
  getHealth: vi.fn(),
}))

vi.mock('@loop/loopit-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@loop/loopit-client')>()),
  createPreviewUrl: client.createPreviewUrl,
  streamRunEvents: client.streamRunEvents,
  getHealth: client.getHealth,
}))

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
}

beforeEach(() => {
  client.createPreviewUrl.mockReset()
  client.streamRunEvents.mockReset()
  client.getHealth.mockReset()
})

describe('parseSseChunk (B17)', () => {
  it('skips malformed JSON instead of throwing', () => {
    expect(parseSseChunk('data: {not-json\n\n')).toBeNull()
    expect(parseSseChunk('data: {"kind":"chat","role":"assistant","text":"hi"}\n')).toEqual({
      kind: 'chat',
      role: 'assistant',
      text: 'hi',
    })
  })

  it('recognises the end event', () => {
    expect(parseSseChunk('event: end\ndata: {}\n')).toBe('end')
  })
})

describe('parsePreviewExpiresAt / previewRefreshDelayMs (B11)', () => {
  it('assumes 900s when expires_at is missing', () => {
    const now = 1_700_000_000_000
    expect(parsePreviewExpiresAt(undefined, now)).toBe(now + PREVIEW_TTL_SECONDS * 1000)
  })

  it('refetches at 80% of remaining TTL', () => {
    const now = 1_000_000
    expect(previewRefreshDelayMs(now + 900_000, now)).toBe(720_000)
  })
})

describe('usePreviewUrl', () => {
  it('exposes url + expiresAt from the client', async () => {
    client.createPreviewUrl.mockResolvedValue({
      url: '/api/loopit/projects/p/site/t/tok/index.html',
      expiresAt: Date.now() + 900_000,
    })
    const { result } = renderHook(() => usePreviewUrl('proj', 'index.html'), { wrapper })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data?.url).toContain('/site/t/tok/')
  })
})

describe('useGatesEnabled (B9 / 1.10)', () => {
  it('hides gates in local mode unless local_gates is set; shows for orchestrator', async () => {
    client.getHealth.mockResolvedValue({ status: 'ok', offline: false, exec_enabled: false, projects_root: '/', run_execution_mode: 'local' })
    const local = renderHook(() => useGatesEnabled(), { wrapper })
    await waitFor(() => expect(client.getHealth).toHaveBeenCalled())
    expect(local.result.current).toBe(false)

    client.getHealth.mockResolvedValue({
      status: 'ok', offline: false, exec_enabled: false, projects_root: '/', run_execution_mode: 'local', local_gates: true,
    })
    const localWired = renderHook(() => useGatesEnabled(), { wrapper })
    await waitFor(() => expect(localWired.result.current).toBe(true))

    client.getHealth.mockResolvedValue({ status: 'ok', offline: false, exec_enabled: false, projects_root: '/', run_execution_mode: 'orchestrator' })
    const orch = renderHook(() => useGatesEnabled(), { wrapper })
    await waitFor(() => expect(orch.result.current).toBe(true))
  })
})

describe('useRunStream reconnect (B17)', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('reconnects with ?after= when the stream closes while live', async () => {
    vi.useFakeTimers()
    const calls: Array<{ after?: number }> = []
    client.streamRunEvents.mockImplementation(async (_runId: string, onEvent: (e: unknown) => void, opts?: { after?: number; signal?: AbortSignal }) => {
      calls.push({ after: opts?.after })
      if (calls.length === 1) {
        onEvent({ kind: 'chat', role: 'assistant', text: 'hi', _seq: 3 })
        return
      }
      // Second open: hang until aborted so the hook can clean up.
      await new Promise<void>((resolve) => {
        opts?.signal?.addEventListener('abort', () => resolve(), { once: true })
      })
    })

    const onEvent = vi.fn()
    const { unmount } = renderHook(
      () => useRunStream('run_1', true, onEvent, { live: true }),
      { wrapper },
    )

    await act(async () => { await Promise.resolve() })
    expect(calls).toHaveLength(1)
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ _seq: 3 }))

    await act(async () => { await vi.advanceTimersByTimeAsync(500) })
    await act(async () => { await Promise.resolve() })

    expect(calls.length).toBeGreaterThanOrEqual(2)
    expect(calls[1]?.after).toBe(3)

    unmount()
  })

  it('does not reconnect after a clean close when the run is finished', async () => {
    vi.useFakeTimers()
    client.streamRunEvents.mockResolvedValue(undefined)
    const { unmount } = renderHook(
      () => useRunStream('run_done', true, () => {}, { live: false }),
      { wrapper },
    )
    await act(async () => { await Promise.resolve() })
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    expect(client.streamRunEvents).toHaveBeenCalledTimes(1)
    unmount()
  })
})
