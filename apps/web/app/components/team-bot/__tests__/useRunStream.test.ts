import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useRunStream } from '../useRunStream'

const getBotTask = vi.fn()
const getBotComputer = vi.fn()
const streamBotRun = vi.fn()

vi.mock('../../../lib/bot', () => ({
  getBotTask: (...args: unknown[]) => getBotTask(...args),
  getBotComputer: (...args: unknown[]) => getBotComputer(...args),
  streamBotRun: (...args: unknown[]) => streamBotRun(...args),
}))

describe('useRunStream', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    getBotTask.mockReset()
    getBotComputer.mockReset()
    streamBotRun.mockReset()
    streamBotRun.mockReturnValue(() => {})
    getBotComputer.mockResolvedValue({ sandboxId: 'sbx', active: true })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('waits for a run instead of hard-failing when none exists yet', async () => {
    getBotTask
      .mockResolvedValueOnce({ id: 't1', goal: 'g', runs: [] })
      .mockResolvedValueOnce({
        id: 't1',
        goal: 'g',
        runs: [{ id: 'r1', status: 'running' }],
      })

    const { result } = renderHook(() => useRunStream('t1'))

    await act(async () => {
      await Promise.resolve()
    })
    expect(result.current.runId).toBeNull()
    expect(result.current.loadError).toBe('')

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000)
    })
    expect(result.current.runId).toBe('r1')
    expect(streamBotRun).toHaveBeenCalledWith('r1', expect.any(Function), expect.any(Function), expect.any(Function))
  })

  it('does not restart the computer poll when computer state updates', async () => {
    getBotTask.mockResolvedValue({
      id: 't1',
      goal: 'g',
      runs: [{ id: 'r1', status: 'running' }],
    })
    getBotComputer
      .mockResolvedValueOnce({ sandboxId: 'sbx', active: true, minutes: 1 })
      .mockResolvedValue({ sandboxId: 'sbx', active: true, minutes: 2 })

    renderHook(() => useRunStream('t1'))

    await act(async () => {
      await Promise.resolve()
    })

    const callsAfterAttach = getBotComputer.mock.calls.length
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000)
    })
    // One interval tick — not a storm of calls from a hot dependency loop.
    expect(getBotComputer.mock.calls.length - callsAfterAttach).toBeLessThanOrEqual(2)
  })

  it('surfaces stream errors from streamBotRun', async () => {
    getBotTask.mockResolvedValue({
      id: 't1',
      goal: 'g',
      runs: [{ id: 'r1', status: 'running' }],
    })
    let onError: ((msg: string) => void) | undefined
    streamBotRun.mockImplementation((_id, _onEvent, _onDone, err) => {
      onError = err
      return () => {}
    })

    const { result } = renderHook(() => useRunStream('t1'))
    await act(async () => { await Promise.resolve() })
    await act(async () => { onError?.('stream exploded') })
    expect(result.current.loadError).toMatch(/stream exploded/i)
  })

  it('clears the previous run when the task changes', async () => {
    getBotTask.mockImplementation(async (id: string) => ({
      id,
      goal: id,
      runs: [{ id: `run-${id}`, status: 'running' }],
    }))
    const handlers: Array<(event: { type: string; message?: string }) => void> = []
    streamBotRun.mockImplementation((_id: string, handler: (event: { type: string; message?: string }) => void) => {
      handlers.push(handler)
      return () => {}
    })

    const { result, rerender } = renderHook(({ id }: { id: string }) => useRunStream(id), {
      initialProps: { id: 't1' },
    })
    await act(async () => { await Promise.resolve() })
    await act(async () => { handlers[0]?.({ type: 'status', message: 'from-t1' }) })
    expect(result.current.events.map((event) => event.message)).toContain('from-t1')
    expect(result.current.runId).toBe('run-t1')

    rerender({ id: 't2' })
    await act(async () => { await Promise.resolve() })
    expect(result.current.runId).toBe('run-t2')
    expect(result.current.task && 'id' in result.current.task ? result.current.task.id : null).toBe('t2')
    expect(result.current.events.map((event) => event.message)).not.toContain('from-t1')
  })

  it('reconnects the stream when retry is called', async () => {
    getBotTask.mockResolvedValue({
      id: 't1',
      goal: 'g',
      runs: [{ id: 'r1', status: 'running' }],
    })
    let onError: ((msg: string) => void) | undefined
    streamBotRun.mockImplementation((_id, _onEvent, _onDone, err) => {
      onError = err
      return () => {}
    })

    const { result } = renderHook(() => useRunStream('t1'))
    await act(async () => { await Promise.resolve() })
    const calls = streamBotRun.mock.calls.length
    await act(async () => { onError?.('stream exploded') })
    expect(result.current.loadError).toMatch(/stream exploded/i)

    await act(async () => { result.current.retry() })
    await act(async () => { await Promise.resolve() })
    expect(streamBotRun.mock.calls.length).toBeGreaterThan(calls)
    expect(result.current.loadError).toBe('')
  })
})
