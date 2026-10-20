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
})
