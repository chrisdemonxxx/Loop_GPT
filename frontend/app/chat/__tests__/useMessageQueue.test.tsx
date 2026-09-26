import { describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useMessageQueue } from '../hooks'
import type { QueuedMessage } from '../../components/chat/types'

/** Per-message queue (audit §8-39): a send while a run is active is queued
 *  (never dropped) and auto-dispatches FIFO when the run completes. */

const entry = (id: string, over: Partial<QueuedMessage> = {}): QueuedMessage => ({
  id, content: `message ${id}`, attachmentIds: [], previews: [], docNames: [],
  sendMode: 'agent', runMode: 'auto', modelTier: 'loop-large', selectedTools: null,
  incognito: false, ...over,
})

function setup(initialRunning = false) {
  const dispatch = vi.fn()
  const rendered = renderHook(({ running }) => useMessageQueue(running, dispatch), {
    initialProps: { running: initialRunning },
  })
  return { dispatch, ...rendered }
}

describe('useMessageQueue (§8-39)', () => {
  it('enqueues entries and removes them individually', () => {
    const { result } = setup()
    act(() => result.current.enqueue(entry('a')))
    act(() => result.current.enqueue(entry('b')))
    expect(result.current.queue.map((q) => q.id)).toEqual(['a', 'b'])
    act(() => result.current.remove('a'))
    expect(result.current.queue.map((q) => q.id)).toEqual(['b'])
  })

  it('drains FIFO when a run completes (true → false)', () => {
    const { result, dispatch, rerender } = setup(true)
    act(() => result.current.enqueue(entry('a')))
    act(() => result.current.enqueue(entry('b')))
    expect(dispatch).not.toHaveBeenCalled() // still running: nothing sends
    rerender({ running: false })
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }))
    expect(result.current.queue.map((q) => q.id)).toEqual(['b'])
    // The next run (true) then its completion drains the next one.
    rerender({ running: true })
    rerender({ running: false })
    expect(dispatch).toHaveBeenCalledTimes(2)
    expect(dispatch).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'b' }))
    expect(result.current.queue).toHaveLength(0)
  })

  it('does not drain on mount or while runs stay active', () => {
    const { result, dispatch, rerender } = setup(false)
    act(() => result.current.enqueue(entry('a')))
    // false → false: no edge, no dispatch.
    rerender({ running: false })
    expect(dispatch).not.toHaveBeenCalled()
    // Run starts: enqueued message must NOT be dispatched.
    rerender({ running: true })
    expect(dispatch).not.toHaveBeenCalled()
    expect(result.current.queue.map((q) => q.id)).toEqual(['a'])
  })

  it('clear() empties the queue (conversation switch)', () => {
    const { result } = setup()
    act(() => result.current.enqueue(entry('a')))
    act(() => result.current.enqueue(entry('b')))
    act(() => result.current.clear())
    expect(result.current.queue).toHaveLength(0)
  })

  it('never double-sends an entry when the drain races a state double-pass', () => {
    const { result, dispatch, rerender } = setup(true)
    act(() => result.current.enqueue(entry('a')))
    // Simulate React re-running the effect without a new running edge:
    // prevRunning is false now, so a second pass must not dispatch again.
    rerender({ running: false })
    rerender({ running: false })
    expect(dispatch).toHaveBeenCalledTimes(1)
  })
})
