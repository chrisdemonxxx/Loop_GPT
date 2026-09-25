import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeOutputBatcher } from '../../agent/tools/executeCode'

/** Output batcher (audit §8-28): child-process chunks coalesce into bounded
 * flushes so live output streams without per-line SSE spam. */

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('makeOutputBatcher', () => {
  it('flushes when the size cap is reached', () => {
    const emit = vi.fn()
    const b = makeOutputBatcher(emit, { maxChars: 40 })
    b.push('x'.repeat(20), 'stdout')
    expect(emit).not.toHaveBeenCalled() // below cap: waiting on the timer
    b.push('y'.repeat(30), 'stdout') // crosses the cap: flush immediately
    expect(emit).toHaveBeenCalledTimes(1)
    expect(emit).toHaveBeenCalledWith('x'.repeat(20) + 'y'.repeat(30), 'stdout')
  })

  it('flushes on the freshness timer and cancels pending schedules', () => {
    const emit = vi.fn()
    const b = makeOutputBatcher(emit, { maxChars: 400, maxMs: 150 })
    b.push('hello', 'stdout')
    expect(emit).not.toHaveBeenCalled()
    vi.advanceTimersByTime(160)
    expect(emit).toHaveBeenCalledWith('hello', 'stdout')
    // A flush cancels the pending timer: no double emit.
    vi.advanceTimersByTime(500)
    expect(emit).toHaveBeenCalledTimes(1)
  })

  it('keeps stdout and stderr in separate flushes', () => {
    const emit = vi.fn()
    const b = makeOutputBatcher(emit, { maxChars: 400, maxMs: 150 })
    b.push('out-chunk', 'stdout')
    b.push('err-chunk', 'stderr')
    vi.advanceTimersByTime(160)
    expect(emit).toHaveBeenCalledTimes(2)
    expect(emit).toHaveBeenCalledWith('out-chunk', 'stdout')
    expect(emit).toHaveBeenCalledWith('err-chunk', 'stderr')
  })

  it('the explicit final flush drains anything still buffered', () => {
    const emit = vi.fn()
    const b = makeOutputBatcher(emit, { maxChars: 100, maxMs: 150 })
    b.push('tail', 'stdout')
    expect(emit).not.toHaveBeenCalled()
    b.flush()
    expect(emit).toHaveBeenCalledWith('tail', 'stdout')
    // Idempotent: a second flush of empty buffers emits nothing.
    b.flush()
    expect(emit).toHaveBeenCalledTimes(1)
  })
})
