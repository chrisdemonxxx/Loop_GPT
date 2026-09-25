import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  appendEvent, attach, cancelRun, createRun, findRun, finishRun, resetRunsForTest,
} from '../runReplay'
import type { AgentEvent } from '../../agent/types'

/** Durable run replay store (audit §8-30): sequencing, buffered replay
 * after a cursor (after = the last seq the client received; -1 = full),
 * live listener broadcast, explicit cancel, and overflow degradation. */

const ev = (type: string, over: Partial<AgentEvent> = {}): AgentEvent =>
  ({ type, ...over } as AgentEvent)

beforeEach(() => resetRunsForTest())
afterEach(() => resetRunsForTest())

describe('runReplay store', () => {
  it('sequences events and replays after the received-seq cursor', () => {
    const run = createRun({ runId: 'r1', userId: 'u1', conversationId: 'c1' })
    const first = appendEvent(run, ev('run', { runId: 'r1' } as any))
    const second = appendEvent(run, ev('delta', { step: 0, text: 'hi' }))
    expect(first.seq).toBe(0)
    expect(second.seq).toBe(1)
    // Full replay (nothing received yet).
    expect(attach(run, -1, () => {}).replay.map((e) => e.seq)).toEqual([0, 1])
    // A client that received seq 0 resumes from 1 onward.
    expect(attach(run, 0, () => {}).replay.map((e) => e.seq)).toEqual([1])
    // A client fully caught up replays nothing.
    expect(attach(run, 1, () => {}).replay).toEqual([])
  })

  it('broadcasts live events to attached listeners and detaches cleanly', () => {
    const run = createRun({ runId: 'r1', userId: 'u1', conversationId: 'c1' })
    appendEvent(run, ev('run', { runId: 'r1' } as any)) // seq 0
    const seen: number[] = []
    const { replay, live, detach } = attach(run, -1, (e) => seen.push(e.seq))
    expect(replay).toHaveLength(1)
    expect(live).toBe(true)
    appendEvent(run, ev('delta', { step: 0, text: 'b' })) // seq 1
    expect(seen).toEqual([1]) // only the live event, not the replay
    detach()
    appendEvent(run, ev('delta', { step: 0, text: 'c' })) // seq 2
    expect(seen).toEqual([1]) // detached: nothing more arrives
  })

  it('finishRun clears listeners and refuses live attach afterwards', () => {
    const run = createRun({ runId: 'r1', userId: 'u1', conversationId: 'c1' })
    appendEvent(run, ev('final', { content: 'done' }))
    appendEvent(run, ev('done'))
    finishRun(run)
    const { replay, live } = attach(run, -1, () => {})
    expect(live).toBe(false) // replay-only: the buffer still serves
    expect(replay.map((e) => e.type)).toEqual(['final', 'done'])
  })

  it('cancelRun aborts the shared controller exactly once', () => {
    const controller = new AbortController()
    const run = createRun({ runId: 'r1', userId: 'u1', conversationId: 'c1', controller })
    expect(cancelRun(run)).toBe(true)
    expect(controller.signal.aborted).toBe(true)
    finishRun(run)
    expect(cancelRun(run)).toBe(false) // already finished: no double cancel
  })

  it('findRun enforces user + conversation ownership', () => {
    createRun({ runId: 'r1', userId: 'u1', conversationId: 'c1' })
    expect(findRun('r1', 'u1', 'c1')).not.toBeNull()
    expect(findRun('r1', 'u2', 'c1')).toBeNull() // foreign user
    expect(findRun('r1', 'u1', 'c2')).toBeNull() // mismatched conversation
    expect(findRun('missing', 'u1', 'c1')).toBeNull()
  })

  it('degrades resumability (not the run) when the buffer overflows', () => {
    const run = createRun({ runId: 'r1', userId: 'u1', conversationId: 'c1' })
    ;(run as any).bytes = 2_000_000 // simulate hitting the byte cap
    appendEvent(run, ev('delta', { step: 0, text: 'x' }))
    expect(run.truncated).toBe(true)
    expect(run.events).toHaveLength(0) // buffer dropped
    // Resume from the start is refused; the run itself keeps broadcasting.
    const seen: number[] = []
    const { replay, live } = attach(run, -1, (e) => seen.push(e.seq))
    expect(replay).toHaveLength(0)
    expect(live).toBe(false)
    appendEvent(run, ev('delta', { step: 0, text: 'y' }))
    expect(seen).toEqual([]) // no listener attached
  })
})
