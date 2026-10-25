import { describe, expect, it, vi } from 'vitest'

vi.mock('../prisma', () => ({ prisma: null, hasDb: false }))

import { startRun, subscribe } from '../botRuns'

describe('botRuns event seq cursor', () => {
  it('stamps monotonic seq and survives the 800-event ring buffer', async () => {
    const run = await startRun('task-seq-1')
    const seen: number[] = []
    const unsub = subscribe(run.runId, (event) => {
      const seq = (event as { seq?: number }).seq
      if (typeof seq === 'number') seen.push(seq)
    })

    for (let i = 0; i < 810; i++) {
      run.emit({ type: 'status', message: `e${i}` })
    }
    // Live listener saw every emit (including those later shifted from the ring).
    expect(seen.length).toBe(810)
    expect(seen[0]).toBe(1)
    expect(seen[seen.length - 1]).toBe(810)

    // A late subscriber with after=800 only gets events with seq > 800.
    const late: number[] = []
    subscribe(run.runId, (event) => {
      const seq = (event as { seq?: number }).seq
      if (typeof seq === 'number') late.push(seq)
    }, { after: 800 })
    expect(late.every((s) => s > 800)).toBe(true)
    expect(late[late.length - 1]).toBe(810)

    unsub()
    await run.complete({ content: 'done', artifacts: [], usage: { tokensIn: 0, tokensOut: 0 } })
  })

  it('delivers done when the subscriber finishes the run during replay', async () => {
    const run = await startRun('task-seq-done')
    run.emit({ type: 'status', message: 'hi' })
    const seen: string[] = []
    subscribe(run.runId, (event) => {
      seen.push(event.type)
      if (event.type === 'status') {
        void run.complete({ content: 'done', artifacts: [], usage: { tokensIn: 0, tokensOut: 0 } })
      }
    })
    expect(seen).toContain('done')
  })
})
