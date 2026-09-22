import { describe, expect, it, vi } from 'vitest'
import { streamTurn } from '../llmClient'
import type { ChatMessage } from '../types'

function iterableOf(chunks: any[]) {
  return (async function* () { for (const c of chunks) yield c })()
}

function fakeClient(create: any) {
  return { chat: { completions: { create } } } as any
}

const messages: ChatMessage[] = [{ role: 'user', content: 'hi' }]

describe('cold-start retry in the provider layer', () => {
  it('retries 503s and then streams the successful turn', async () => {
    const create = vi.fn()
      .mockRejectedValueOnce({ status: 503, message: 'Service Unavailable' })
      .mockRejectedValueOnce({ status: 503, message: 'Service Unavailable' })
      .mockResolvedValueOnce(iterableOf([
        { choices: [{ delta: { content: 'hello' } }] },
        { choices: [{ delta: { content: ' world' }, finish_reason: 'stop' }] },
      ]))
    const warming = vi.fn()

    const result = await streamTurn({
      client: fakeClient(create), model: 'm', messages, onWarming: warming,
    })

    expect(create).toHaveBeenCalledTimes(3)
    expect(result.content).toBe('hello world')
    expect(result.finishReason).toBe('stop')
    expect(warming).toHaveBeenCalled()
  }, 20000)

  it('does not retry a non-cold error', async () => {
    const create = vi.fn().mockRejectedValue({ status: 400, message: 'bad request' })
    await expect(streamTurn({ client: fakeClient(create), model: 'm', messages })).rejects.toMatchObject({ status: 400 })
    expect(create).toHaveBeenCalledTimes(1)
  })

  it('stops retrying when the run is aborted', async () => {
    const controller = new AbortController()
    const create = vi.fn().mockImplementation(async () => {
      controller.abort()
      throw { status: 503, message: 'Service Unavailable' }
    })
    await expect(streamTurn({ client: fakeClient(create), model: 'm', messages, signal: controller.signal })).rejects.toBeTruthy()
    expect(create).toHaveBeenCalledTimes(1)
  })
})
