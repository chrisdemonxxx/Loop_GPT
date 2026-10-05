/**
 * Vision feedback loop (Phase 3): a tool that returns data.imageDataUri (e.g.
 * computer_* screenshots) must have its frame injected as a real image part in
 * the next model turn — both the native tool-calling path and the inline
 * ReAct fallback path.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const streamTurn = vi.fn()
vi.mock('../llmClient', () => ({
  createClient: () => ({}),
  resolveModel: () => 'fake-model',
  isOpenAICompatible: () => true,
  streamTurn: (...args: any[]) => streamTurn(...args),
}))
vi.mock('../../services/workspaces', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/workspaces')>()
  return { ...actual, workspaceDb: () => ({ conversation: { findFirst: async () => ({ id: 'c' }) } }) }
})

import { runAgent } from '../agentRuntime'
import { authorizeRunContext } from '../runAuthorization'
import { toolRegistry } from '../toolRegistry'
import type { ToolDefinition } from '../types'

const FRAME_URI = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg=='

const frameTool: ToolDefinition = {
  name: 'fake_frame_tool',
  source: 'builtin',
  description: 'returns a frame',
  parameters: { type: 'object', properties: {} },
  handler: async () => ({ content: 'frame captured', data: { imageDataUri: FRAME_URI } }),
}

beforeAll(() => {
  toolRegistry.register(frameTool)
})

beforeEach(() => {
  // Clear calls AND the once-queue so per-test mock turns can't leak.
  streamTurn.mockReset()
})

function imageMessages(messages: any[]) {
  return messages.filter((m) => m.role === 'user' && Array.isArray(m.content) &&
    m.content.some((part: any) => part.type === 'image_url'))
}

describe('tool-returned images reach the next model turn', () => {
  it('native path: the frame follows the tool result as a user image message', async () => {
    streamTurn
      .mockResolvedValueOnce({ content: '', reasoning: '', toolCalls: [{ id: 'call-1', name: 'fake_frame_tool', arguments: '{}' }] })
      .mockResolvedValueOnce({ content: 'I can see the screen.', reasoning: '', toolCalls: [] })
    const ctx = await authorizeRunContext(
      { userId: 'u', conversationId: 'c', emit: () => {}, scratch: {} },
      'w',
      [frameTool],
    )
    const result = await runAgent({
      messages: [{ role: 'user', content: 'look at the screen' }],
      provider: 'openai',
      model: 'fake-model',
      toolNames: ['fake_frame_tool'],
      ctx,
      useMemory: false,
      baseUrl: 'https://native-path.test',
    })
    expect(result.content).toBe('I can see the screen.')
    expect(streamTurn).toHaveBeenCalledTimes(2)
    const secondTurnMessages = streamTurn.mock.calls[1][0].messages
    const images = imageMessages(secondTurnMessages)
    expect(images).toHaveLength(1)
    const parts = images[0].content
    expect(parts.find((p: any) => p.type === 'image_url')?.image_url.url).toBe(FRAME_URI)
    expect(parts.find((p: any) => p.type === 'text')?.text).toContain('fake_frame_tool')
  })

  it('inline path: frames collected during the turn arrive as one image message', async () => {
    streamTurn
      .mockResolvedValueOnce({ content: '{"tool":"fake_frame_tool","arguments":{}}', reasoning: '', toolCalls: [] })
      .mockResolvedValueOnce({ content: 'Inline vision works too.', reasoning: '', toolCalls: [] })
    const ctx = await authorizeRunContext(
      { userId: 'u', conversationId: 'c', emit: () => {}, scratch: {} },
      'w',
      [frameTool],
    )
    const result = await runAgent({
      messages: [{ role: 'user', content: 'look at the screen' }],
      provider: 'openai',
      model: 'fake-model',
      toolNames: ['fake_frame_tool'],
      ctx,
      useMemory: false,
      baseUrl: 'https://inline-path.test',
    })
    expect(result.content).toBe('Inline vision works too.')
    expect(streamTurn).toHaveBeenCalledTimes(2)
    const secondTurnMessages = streamTurn.mock.calls[1][0].messages
    const images = imageMessages(secondTurnMessages)
    expect(images).toHaveLength(1)
    expect(images[0].content.find((p: any) => p.type === 'image_url')?.image_url.url).toBe(FRAME_URI)
  })
})
