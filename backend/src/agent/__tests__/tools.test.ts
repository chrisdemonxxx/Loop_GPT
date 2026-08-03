import { describe, it, expect, beforeAll } from 'vitest'
import { registerBuiltinTools } from '../index'
import { toolRegistry } from '../toolRegistry'
import type { ToolContext } from '../types'

const ctx: ToolContext = { userId: 'u', conversationId: 'c', emit: () => {}, scratch: {} }

beforeAll(() => registerBuiltinTools())

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
    expect(r.data?.artifact?.url).toMatch(/\/uploads\/artifacts\//)
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
  })

  it('unknown tool returns an error result, not a throw', async () => {
    const r = await toolRegistry.execute('does_not_exist', {}, ctx)
    expect(r.isError).toBe(true)
  })
})
