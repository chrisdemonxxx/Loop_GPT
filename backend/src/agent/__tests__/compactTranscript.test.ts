import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../llmClient', () => ({
  completeOnce: vi.fn(async () => 'SUMMARY: the thread continues\nFACTS: none'),
}))
vi.mock('../../services/prisma', () => ({ prisma: null }))

import {
  IMAGE_CHAR_EQUIVALENT,
  compactTranscript,
  compactionTailStart,
  transcriptSize,
} from '../compactTranscript'
import type { ChatMessage } from '../types'

const big = 'x'.repeat(20_000)

describe('compactTranscript', () => {
  beforeEach(() => vi.clearAllMocks())

  it('counts images and tool-call arguments toward the transcript budget', () => {
    const image: ChatMessage = {
      role: 'user',
      content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,aa' } }],
    }
    expect(transcriptSize([image])).toBe(IMAGE_CHAR_EQUIVALENT)
    const call = {
      role: 'assistant' as const,
      content: 'hi',
      tool_calls: [{ function: { name: 'web', arguments: 'abcdef' } }],
    }
    expect(transcriptSize([call as ChatMessage])).toBe('hi'.length + 'web'.length + 'abcdef'.length)
  })

  it('keeps a tool call with its result and does not drop the first tail message', async () => {
    const tail = Array.from({ length: 11 }, (_, i) => ({ role: 'user' as const, content: `tail-${i}` }))
    const assistant = {
      role: 'assistant' as const,
      content: '',
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'web_search', arguments: '{"q":"loop"}' } }],
    }
    const tool = { role: 'tool' as const, content: 'found it', tool_call_id: 'c1' }
    const msgs: ChatMessage[] = [
      { role: 'system', content: 'sys' },
      ...Array.from({ length: 6 }, () => ({ role: 'user' as const, content: big })),
      assistant as ChatMessage,
      tool,
      ...tail,
    ]
    expect(compactionTailStart(msgs)).toBe(msgs.indexOf(assistant as ChatMessage))

    const result = await compactTranscript({ msgs, client: {} as any, model: 'fake' })
    expect(result.compacted).toBe(true)
    expect(msgs.some((m) => m.role === 'tool' && m.content === 'found it')).toBe(true)
    expect(msgs.filter((m) => typeof m.content === 'string' && m.content.startsWith('tail-'))).toHaveLength(11)
    expect(msgs[0].role).toBe('system')
    expect(String(msgs[1].content)).toContain('the thread continues')
  })
})
