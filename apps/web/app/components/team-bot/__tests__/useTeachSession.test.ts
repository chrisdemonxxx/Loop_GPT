import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useTeachSession } from '../useTeachSession'

const enqueueBotTask = vi.fn()
const getBotTask = vi.fn()
const getBotComputer = vi.fn()
const setBotTakeover = vi.fn()
const cancelBotTask = vi.fn()
const streamBotRun = vi.fn()
const appendBotTeachStep = vi.fn()
const discardBotTeach = vi.fn()

vi.mock('../../../lib/bot', () => ({
  enqueueBotTask: (...args: unknown[]) => enqueueBotTask(...args),
  getBotTask: (...args: unknown[]) => getBotTask(...args),
  getBotComputer: (...args: unknown[]) => getBotComputer(...args),
  setBotTakeover: (...args: unknown[]) => setBotTakeover(...args),
  cancelBotTask: (...args: unknown[]) => cancelBotTask(...args),
  streamBotRun: (...args: unknown[]) => streamBotRun(...args),
  appendBotTeachStep: (...args: unknown[]) => appendBotTeachStep(...args),
  discardBotTeach: (...args: unknown[]) => discardBotTeach(...args),
}))

type TeachEvent = { type: string; skillId?: string; message?: string; name?: string }

function runningTask(id: string, runId: string) {
  return {
    id,
    status: 'processing',
    runs: [{ id: runId, status: 'running' }],
  }
}

describe('useTeachSession', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    enqueueBotTask.mockReset()
    getBotTask.mockReset()
    getBotComputer.mockReset()
    setBotTakeover.mockReset()
    cancelBotTask.mockReset()
    streamBotRun.mockReset()
    appendBotTeachStep.mockReset()
    discardBotTeach.mockReset()
    discardBotTeach.mockResolvedValue({ ok: true, discarded: true })
    streamBotRun.mockReturnValue(() => {})
    getBotComputer.mockResolvedValue(null)
    setBotTakeover.mockResolvedValue({ takeoverRequested: true, interactiveUrl: null })
    cancelBotTask.mockResolvedValue({ cancelled: true, immediate: false })
    appendBotTeachStep.mockResolvedValue({ ok: true, stored: true })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('ignores skill_saved until Stop, then reaches done only from distilling', async () => {
    const onReady = vi.fn()
    let onEvent: ((e: TeachEvent) => void) | null = null
    streamBotRun.mockImplementation((_id: string, handler: typeof onEvent) => {
      handler?.({ type: 'skill_saved', skillId: 'too-soon' })
      onEvent = handler
      return () => {}
    })
    enqueueBotTask.mockResolvedValue({ task: { id: 'task-1' }, suggestedSkills: [] })
    getBotTask.mockResolvedValue(runningTask('task-1', 'run-1'))

    const { result } = renderHook(() => useTeachSession(onReady))

    await act(async () => {
      await result.current.start('Demo a login flow')
    })
    expect(result.current.phase).toBe('starting')
    expect(result.current.skillId).toBeNull()

    act(() => { result.current.reportInput({ kind: 'click', x: 1, y: 2 }) })
    expect(appendBotTeachStep).not.toHaveBeenCalled()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000)
    })
    expect(streamBotRun).toHaveBeenCalled()
    expect(setBotTakeover).toHaveBeenCalledWith('run-1', true)
    expect(result.current.phase).toBe('recording')
    expect(result.current.skillId).toBeNull()
    expect(onReady).not.toHaveBeenCalled()

    await act(async () => {
      onEvent?.({ type: 'skill_saved', skillId: 'still-no' })
      onEvent?.({ type: 'status', message: 'Waiting for the operator to take over' })
      onEvent?.({ type: 'final' })
    })
    expect(result.current.phase).toBe('recording')
    expect(onReady).not.toHaveBeenCalled()

    await act(async () => {
      result.current.reportInput({ kind: 'click', x: 640, y: 400 })
    })
    expect(appendBotTeachStep).toHaveBeenCalledWith('run-1', expect.objectContaining({
      kind: 'click', x: 640, y: 400,
    }))
    expect(result.current.steps).toBe(1)

    await act(async () => {
      await result.current.stop()
    })
    expect(result.current.phase).toBe('distilling')
    expect(setBotTakeover).toHaveBeenCalledWith('run-1', false)
    expect(onReady).not.toHaveBeenCalled()

    // A timer after Stop must not claim the skill. skill_saved does.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4500)
    })
    expect(result.current.phase).toBe('distilling')

    await act(async () => {
      onEvent?.({ type: 'skill_saved', skillId: 'skill-abc', name: 'Login' })
    })
    expect(result.current.phase).toBe('done')
    expect(result.current.skillId).toBe('skill-abc')
    expect(result.current.skillName).toBe('Login')
    expect(onReady).toHaveBeenCalledWith('skill-abc')
  })

  it('does not count a step the server did not store', async () => {
    streamBotRun.mockReturnValue(() => {})
    enqueueBotTask.mockResolvedValue({ task: { id: 'task-unstored' }, suggestedSkills: [] })
    getBotTask.mockResolvedValue(runningTask('task-unstored', 'run-unstored'))
    appendBotTeachStep.mockResolvedValue({ ok: true, stored: false })

    const { result } = renderHook(() => useTeachSession())
    await act(async () => { await result.current.start('Unstored click') })
    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
    expect(result.current.phase).toBe('recording')

    await act(async () => {
      result.current.reportInput({ kind: 'click', x: 100, y: 200 })
    })
    expect(appendBotTeachStep).toHaveBeenCalledWith('run-unstored', expect.objectContaining({
      kind: 'click', x: 100, y: 200,
    }))
    expect(result.current.steps).toBe(0)
  })

  it('ignores skill_saved while waiting for takeover', async () => {
    let onEvent: ((e: TeachEvent) => void) | null = null
    streamBotRun.mockImplementation((_id: string, handler: typeof onEvent) => {
      handler?.({ type: 'skill_saved', skillId: 'during-start' })
      onEvent = handler
      return () => {}
    })
    enqueueBotTask.mockResolvedValue({ task: { id: 'task-w' }, suggestedSkills: [] })
    getBotTask.mockResolvedValue(runningTask('task-w', 'run-w'))
    setBotTakeover.mockRejectedValueOnce(new Error('desktop not ready'))
    const onReady = vi.fn()

    const { result } = renderHook(() => useTeachSession(onReady))
    await act(async () => { await result.current.start('Teach me') })
    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })

    expect(result.current.phase).toBe('waiting')
    await act(async () => {
      onEvent?.({ type: 'skill_saved', skillId: 'while-waiting' })
    })
    expect(result.current.phase).toBe('waiting')
    expect(result.current.skillId).toBeNull()
    expect(onReady).not.toHaveBeenCalled()
  })

  it('stays recording when Stop cannot release the desktop', async () => {
    streamBotRun.mockReturnValue(() => {})
    enqueueBotTask.mockResolvedValue({ task: { id: 'task-stop' }, suggestedSkills: [] })
    getBotTask.mockResolvedValue(runningTask('task-stop', 'run-stop'))

    const { result } = renderHook(() => useTeachSession())
    await act(async () => { await result.current.start('Show the release') })
    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
    expect(result.current.phase).toBe('recording')

    setBotTakeover.mockRejectedValueOnce(new Error('release failed'))
    await act(async () => { await result.current.stop() })
    expect(result.current.phase).toBe('recording')
    expect(result.current.error).toMatch(/release failed/i)
  })

  it('shows a nothing-recorded failure instead of Skill saved', async () => {
    let onEvent: ((e: TeachEvent) => void) | null = null
    streamBotRun.mockImplementation((_id: string, handler: typeof onEvent) => {
      onEvent = handler
      return () => {}
    })
    enqueueBotTask.mockResolvedValue({ task: { id: 'task-empty' }, suggestedSkills: [] })
    getBotTask.mockResolvedValue(runningTask('task-empty', 'run-empty'))
    const onReady = vi.fn()

    const { result } = renderHook(() => useTeachSession(onReady))
    await act(async () => { await result.current.start('Empty demo') })
    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
    expect(result.current.phase).toBe('recording')

    await act(async () => { await result.current.stop() })
    expect(result.current.phase).toBe('distilling')

    await act(async () => {
      onEvent?.({ type: 'error', message: 'Nothing was recorded' })
    })
    expect(result.current.phase).toBe('failed')
    expect(result.current.error).toMatch(/nothing was recorded/i)
    expect(result.current.skillId).toBeNull()

    await act(async () => {
      onEvent?.({ type: 'skill_saved', skillId: 'should-not-stick' })
    })
    expect(result.current.phase).toBe('failed')
    expect(result.current.skillId).toBeNull()
    expect(onReady).not.toHaveBeenCalled()
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
    expect(result.current.skillId).toBeNull()
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

  it('passes conversationId through to enqueue and omits it when absent', async () => {
    enqueueBotTask.mockResolvedValue({ task: { id: 'task-thread' }, suggestedSkills: [] })
    const withThread = renderHook(() => useTeachSession(() => {}, 'bot-1', 'thread-1'))
    await act(async () => { await withThread.result.current.start('Teach on this thread') })
    expect(enqueueBotTask).toHaveBeenCalledWith(expect.objectContaining({
      botId: 'bot-1',
      conversationId: 'thread-1',
      kind: 'teach',
      computer: { enabled: true, ttlMinutes: 30 },
    }))

    enqueueBotTask.mockClear()
    enqueueBotTask.mockResolvedValue({ task: { id: 'task-plain' }, suggestedSkills: [] })
    const withoutThread = renderHook(() => useTeachSession(() => {}, 'bot-1'))
    await act(async () => { await withoutThread.result.current.start('Teach without a thread') })
    const body = enqueueBotTask.mock.calls[0][0] as { conversationId?: string; botId?: string }
    expect(body.botId).toBe('bot-1')
    expect(body.conversationId).toBeUndefined()
  })

  it('cancel never implies a skill', async () => {
    let onEvent: ((e: TeachEvent) => void) | null = null
    streamBotRun.mockImplementation((_id: string, handler: typeof onEvent) => {
      onEvent = handler
      return () => {}
    })
    enqueueBotTask.mockResolvedValue({ task: { id: 'task-3' }, suggestedSkills: [] })
    getBotTask.mockResolvedValue(runningTask('task-3', 'run-3'))
    cancelBotTask.mockResolvedValue({ cancelled: true, immediate: false })
    const onReady = vi.fn()

    const { result } = renderHook(() => useTeachSession(onReady))
    await act(async () => { await result.current.start('Teach cancel') })
    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
    expect(result.current.phase).toBe('recording')

    await act(async () => { await result.current.cancel() })
    expect(cancelBotTask).toHaveBeenCalledWith('task-3')
    expect(result.current.phase).toBe('failed')
    expect(result.current.error).toMatch(/cancelled/i)
    expect(result.current.skillId).toBeNull()
    expect(onReady).not.toHaveBeenCalled()

    await act(async () => {
      onEvent?.({ type: 'skill_saved', skillId: 'after-cancel' })
    })
    expect(result.current.phase).toBe('failed')
    expect(result.current.skillId).toBeNull()
  })

  it('applies the takeover interactive url before the first click', async () => {
    streamBotRun.mockReturnValue(() => {})
    enqueueBotTask.mockResolvedValue({ task: { id: 'task-url' }, suggestedSkills: [] })
    getBotTask.mockResolvedValue(runningTask('task-url', 'run-url'))
    getBotComputer.mockReturnValue(new Promise(() => {}))
    setBotTakeover.mockResolvedValue({ takeoverRequested: true, interactiveUrl: 'wss://drive' })

    const { result } = renderHook(() => useTeachSession())
    await act(async () => { await result.current.start('Show the checkout') })
    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })

    expect(result.current.phase).toBe('recording')
    expect(result.current.computer?.interactiveUrl).toBe('wss://drive')
    expect(result.current.computer?.takeoverRequested).toBe(true)

    await act(async () => {
      result.current.reportInput({ kind: 'click', x: 12, y: 34 })
    })
    expect(appendBotTeachStep).toHaveBeenCalledWith('run-url', expect.objectContaining({
      kind: 'click', x: 12, y: 34,
    }))
  })

  it('cancels the task when the session unmounts', async () => {
    streamBotRun.mockReturnValue(() => {})
    enqueueBotTask.mockResolvedValue({ task: { id: 'task-leave' }, suggestedSkills: [] })
    getBotTask.mockResolvedValue(runningTask('task-leave', 'run-leave'))
    cancelBotTask.mockResolvedValue({ cancelled: true, immediate: true })

    const { result, unmount } = renderHook(() => useTeachSession())
    await act(async () => { await result.current.start('Leave mid demo') })
    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
    expect(result.current.phase).toBe('recording')

    unmount()
    expect(cancelBotTask).toHaveBeenCalledWith('task-leave')
    expect(setBotTakeover).toHaveBeenCalledWith('run-leave', false)
  })

  it('cancels the task when start times out', async () => {
    enqueueBotTask.mockResolvedValue({ task: { id: 'task-slow' }, suggestedSkills: [] })
    getBotTask.mockResolvedValue({ id: 'task-slow', status: 'processing', runs: [] })
    cancelBotTask.mockResolvedValue({ cancelled: true, immediate: false })

    const { result } = renderHook(() => useTeachSession())
    await act(async () => { await result.current.start('Slow teach') })
    expect(result.current.phase).toBe('starting')

    await act(async () => { await vi.advanceTimersByTimeAsync(90_000) })
    expect(cancelBotTask).toHaveBeenCalledWith('task-slow')
    expect(result.current.phase).toBe('failed')
    expect(result.current.skillId).toBeNull()
  })

  it('sends the skill name and description, and discard is not cancel', async () => {
    enqueueBotTask.mockResolvedValue({ task: { id: 'task-name' }, suggestedSkills: [] })
    getBotTask.mockResolvedValue(runningTask('task-name', 'run-name'))
    const { result } = renderHook(() => useTeachSession())
    await act(async () => {
      await result.current.start({ goal: 'Export invoices', name: 'Invoice export', description: 'Pull the CSV from billing' })
    })
    expect(enqueueBotTask).toHaveBeenCalledWith(expect.objectContaining({
      goal: 'Export invoices',
      kind: 'teach',
      teach: { name: 'Invoice export', description: 'Pull the CSV from billing' },
    }))
    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
    discardBotTeach.mockClear()
    cancelBotTask.mockClear()
    await act(async () => { await result.current.discard() })
    expect(discardBotTeach).toHaveBeenCalledWith('run-name')
    expect(cancelBotTask).toHaveBeenCalledWith('task-name')
    expect(result.current.phase).toBe('idle')

    enqueueBotTask.mockResolvedValue({ task: { id: 'task-cancel' }, suggestedSkills: [] })
    getBotTask.mockResolvedValue(runningTask('task-cancel', 'run-cancel'))
    await act(async () => { await result.current.start('Another demo') })
    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
    discardBotTeach.mockClear()
    await act(async () => { await result.current.cancel() })
    expect(discardBotTeach).not.toHaveBeenCalled()
    expect(result.current.phase).toBe('failed')
    expect(result.current.error).toMatch(/cancelled/i)
  })

  it('learns from a saved recording without taking over', async () => {
    enqueueBotTask.mockResolvedValue({ task: { id: 'task-learn' }, suggestedSkills: [] })
    getBotTask.mockResolvedValue(runningTask('task-learn', 'run-learn'))
    const { result } = renderHook(() => useTeachSession())
    await act(async () => {
      await result.current.learn({ recordingId: 'rec-1', name: 'Invoice export', description: 'Pull the CSV from billing' })
    })
    expect(enqueueBotTask).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'teach',
      teach: { recordingId: 'rec-1', name: 'Invoice export', description: 'Pull the CSV from billing' },
    }))
    expect(setBotTakeover).not.toHaveBeenCalled()
    expect(result.current.phase).toBe('distilling')
  })
})
