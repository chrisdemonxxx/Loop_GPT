import { describe, it, expect, beforeAll, vi } from 'vitest'
vi.mock('../../services/privateFiles', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/privateFiles')>()
  return { ...actual, storePrivateFile: vi.fn(async (input) => ({
    id: '12345678-1234-4123-8123-123456789abc', name: input.name,
    mimeType: input.mimeType, size: input.buffer.length,
  })) }
})
import { storePrivateFile } from '../../services/privateFiles'
import { registerBuiltinTools, builtinTools } from '../index'
import { authorizeRunContext } from '../runAuthorization'
vi.mock('../../services/workspaces', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/workspaces')>()
  return { ...actual, workspaceDb: () => ({ conversation: { findFirst: async () => ({ id: 'c' }) } }) }
})
import { toolRegistry } from '../toolRegistry'
import type { ToolContext } from '../types'

let ctx: ToolContext

beforeAll(async () => {
  registerBuiltinTools()
  ctx = await authorizeRunContext({ userId: 'u', conversationId: 'c', emit: () => {}, scratch: {} }, 'w', builtinTools())
})

describe('built-in tools', () => {
  it('calculator evaluates arithmetic', async () => {
    const r = await toolRegistry.execute('calculator', { expression: '6*7' }, ctx)
    expect(r.isError).toBeFalsy()
    expect(r.content).toContain('42')
  })

  it('calculator rejects non-arithmetic input', async () => {
    const r = await toolRegistry.execute('calculator', { expression: 'process.exit(1)' }, ctx)
    expect(r.isError).toBe(true)
  })

  it('get_current_time formats a timezone', async () => {
    const r = await toolRegistry.execute('get_current_time', { timezone: 'Asia/Tokyo' }, ctx)
    expect(r.isError).toBeFalsy()
    expect(r.content).toContain('Asia/Tokyo')
  })

  it('create_document produces a CSV artifact', async () => {
    const r = await toolRegistry.execute(
      'create_document',
      { format: 'csv', filename: 'test', rows: [['a', 'b'], [1, 2]] },
      ctx
    )
    expect(r.isError).toBeFalsy()
    expect(r.data?.artifact?.url).toMatch(/^\/api\/files\/.+\/content$/)
    expect(storePrivateFile).toHaveBeenLastCalledWith(expect.objectContaining({ userId: 'u', conversationId: 'c', purpose: 'artifact' }))
    expect(r.data?.artifact?.kind).toBe('csv')
  })

  it('create_document produces a PDF artifact', async () => {
    const r = await toolRegistry.execute(
      'create_document',
      { format: 'pdf', title: 'Hi', filename: 'doc', content: '# Heading\nBody text.' },
      ctx
    )
    expect(r.isError).toBeFalsy()
    expect(r.data?.artifact?.kind).toBe('pdf')
    const saved = vi.mocked(storePrivateFile).mock.calls.at(-1)![0]
    expect(saved.buffer.subarray(0, 4).toString()).toBe('%PDF')
  })

  it('unknown tool returns an error result, not a throw', async () => {
    const r = await toolRegistry.execute('does_not_exist', {}, ctx)
    expect(r.isError).toBe(true)
  })
})
