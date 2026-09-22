import { describe, expect, it } from 'vitest'
import { startRun, subscribe, getRun, listRuns } from '../researchRuns'

describe('durable research runs', () => {
  it('tracks progress, replays it to a late subscriber, and completes with a report', async () => {
    const run = startRun({ userId: 'u1', conversationId: 'c1', query: 'topic' })
    run.emit({ type: 'warming', message: 'planning' })
    run.emit({ type: 'tool_call', step: 0, name: 'web_search', args: { query: 'topic' } })

    // A subscriber that connects mid-run gets everything already emitted.
    const seen: any[] = []
    const unsub = subscribe(run.runId, (e) => seen.push(e))
    expect(seen).toHaveLength(2)

    run.emit({ type: 'delta', step: 1, text: 'finding' })
    expect(seen).toHaveLength(3)
    unsub()
    run.emit({ type: 'delta', step: 1, text: 'more' })
    expect(seen).toHaveLength(3)

    run.complete({ report: 'final report', sources: [{ index: 1, title: 'S', url: 'https://s.example' }] })
    const view = await getRun(run.runId, 'u1')
    expect(view?.status).toBe('completed')
    expect(view?.report).toBe('final report')
    expect(view?.sources?.[0].url).toBe('https://s.example')
  })

  it('scopes reads to the owner and by conversation', async () => {
    const run = startRun({ userId: 'owner', conversationId: 'conv-a', query: 'q' })
    run.complete({ report: 'r', sources: [] })

    expect(await getRun(run.runId, 'someone-else')).toBeUndefined()
    expect((await getRun(run.runId, 'owner'))?.query).toBe('q')

    const mine = await listRuns('owner', 'conv-a')
    expect(mine.some((r) => r.id === run.runId)).toBe(true)
    expect(await listRuns('owner', 'conv-b')).toHaveLength(0)
  })

  it('marks a failed run without a report', async () => {
    const run = startRun({ userId: 'u2', conversationId: 'c2', query: 'q' })
    run.fail()
    const view = await getRun(run.runId, 'u2')
    expect(view?.status).toBe('failed')
    expect(view?.report).toBeUndefined()
  })
})
