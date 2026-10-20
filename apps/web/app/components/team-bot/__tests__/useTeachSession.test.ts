import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useTeachSession } from '../useTeachSession'

const enqueueBotTask = vi.fn()
const getBotTask = vi.fn()
const getBotComputer = vi.fn()
const setBotTakeover = vi.fn()
const cancelBotTask = vi.fn()
const streamBotRun = vi.fn()

vi.mock('../../../lib/bot', () => ({
  enqueueBotTask: (...args: unknown[]) => enqueueBotTask(...args),
  getBotTask: (...args: unknown[]) => getBotTask(...args),
  getBotComputer: (...args: unknown[]) => getBotComputer(...args),
  setBotTakeover: (...args: unknown[]) => setBotTakeover(...args),
  cancelBotTask: (...args: unknown[]) => cancelBotTask(...args),
  streamBotRun: (...args: unknown[]) => streamBotRun(...args),
}))

describe('useTeachSession', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    enqueueBotTask.mockReset()
    getBotTask.mockReset()
    getBotComputer.mockReset()
    setBotTakeover.mockReset()
    cancelBotTask.mockReset()
    streamBotRun.mockReset()
    streamBotRun.mockReturnValue(() => {})
    getBotComputer.mockResolvedValue(null)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('reaches done on skill_saved, not on a timer after final', async () => {
    const onReady = vi.fn()
    let onEvent: ((e: { type: string; skillId?: string }) => void) | null = null
    streamBotRun.mockImplementation((_id: string, handler: typeof onEvent) => {
      onEvent = handler
      return () => {}
    })
    enqueueBotTask.mockResolvedValue({ task: { id: 'task-1' }, suggestedSkills: [] })
    getBotTask.mockResolvedValue({
      id: 'task-1',
      status: 'processing',
      runs: [{ id: 'run-1', status: 'running' }],
    })

    const { result } = renderHook(() => useTeachSession(onReady))

    await act(async () => {
      await result.current.start('Demo a login flow')
    })
    expect(result.current.phase).toBe('starting')

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000)
    })
    expect(streamBotRun).toHaveBeenCalled()

    await act(async () => {
      onEvent?.({ type: 'final' })
    })
    expect(result.current.phase).toBe('distilling')
    expect(onReady).not.toHaveBeenCalled()

    // Old bug: 4s timer flipped to done. skill_saved must be required.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4500)
    })
    expect(result.current.phase).toBe('distilling')

    await act(async () => {
      onEvent?.({ type: 'skill_saved', skillId: 'skill-abc' })
    })
    expect(result.current.phase).toBe('done')
    expect(result.current.skillId).toBe('skill-abc')
    expect(onReady).toHaveBeenCalledWith('skill-abc')
  })

  it('fails on dead_letter while waiting for a run', async () => {
    enqueueBotTask.mockResolvedValue({ task: { id: 'task-2' }, suggestedSkills: [] })
    getBotTask.mockResolvedValue({
      id: 'task-2',
      status: 'dead_letter',
      lastErrorCode: 'BOT_COMPUTER_TTL',
      runs: [],
    })

    const { result } = renderHook(() => useTeachSession())

    await act(async () => {
      await result.current.start('Teach me')
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000)
    })
    expect(result.current.phase).toBe('failed')
    expect(result.current.error.toLowerCase()).toContain('ttl')
  })

  it('reset returns to idle after failure', async () => {
    enqueueBotTask.mockRejectedValue(new Error('quota'))
    const { result } = renderHook(() => useTeachSession())
    await act(async () => {
      await result.current.start('x')
    })
    expect(result.current.phase).toBe('failed')
    act(() => { result.current.reset() })
    expect(result.current.phase).toBe('idle')
    expect(result.current.error).toBe('')
  })

  it('cancel from waiting tears down the session', async () => {
    let onEvent: ((e: { type: string; message?: string }) => void) | null = null
    streamBotRun.mockImplementation((_id: string, handler: typeof onEvent) => {
      onEvent = handler
      return () => {}
    })
    enqueueBotTask.mockResolvedValue({ task: { id: 'task-3' }, suggestedSkills: [] })
    getBotTask.mockResolvedValue({
      id: 'task-3',
      status: 'processing',
      runs: [{ id: 'run-3', status: 'running' }],
    })
    cancelBotTask.mockResolvedValue({ cancelled: true, immediate: false })

    const { result } = renderHook(() => useTeachSession())
    await act(async () => { await result.current.start('Teach cancel') })
    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
    await act(async () => {
      onEvent?.({ type: 'status', message: 'Waiting for the operator to take over' })
    })
    expect(result.current.phase).toBe('waiting')

    await act(async () => { await result.current.cancel() })
    expect(cancelBotTask).toHaveBeenCalledWith('task-3')
    expect(result.current.phase).toBe('failed')
    expect(result.current.error).toMatch(/cancelled/i)
  })
})
