import { describe, it, expect, beforeAll } from 'vitest'
import { registerBuiltinTools } from '../index'
import { parseInlineToolCall, parseInlineToolCalls } from '../agentRuntime'
import { toolRegistry } from '../toolRegistry'
import type { ToolDefinition, ToolContext } from '../types'

beforeAll(() => registerBuiltinTools())

describe('parseInlineToolCall (ReAct fallback)', () => {
  it('parses a bare JSON tool call', () => {
    const p = parseInlineToolCall('{"tool":"calculator","arguments":{"expression":"1+1"}}')
    expect(p).toEqual({ name: 'calculator', args: { expression: '1+1' } })
  })

  it('parses a fenced json block with surrounding prose', () => {
    const p = parseInlineToolCall('Let me compute.\n```json\n{"tool":"calculator","arguments":{"expression":"2*3"}}\n```')
    expect(p?.name).toBe('calculator')
  })

  it('accepts name/args aliases', () => {
    const p = parseInlineToolCall('{"name":"web_search","args":{"query":"hi"}}')
    expect(p).toEqual({ name: 'web_search', args: { query: 'hi' } })
  })

  it('returns null for plain prose', () => {
    expect(parseInlineToolCall('Here is the final answer, no tools needed.')).toBeNull()
  })

  it('returns null for JSON referencing an unknown tool', () => {
    expect(parseInlineToolCall('{"tool":"nope","arguments":{}}')).toBeNull()
  })

  it('parses MULTIPLE <tool_call> blocks in one turn', () => {
    const content =
      '<tool_call>\n{"tool": "calculator", "arguments": {"expression": "19 * 23"}}\n</tool_call>\n' +
      '<tool_call>\n{"tool": "get_current_time", "arguments": {"timezone": "Asia/Tokyo"}}\n</tool_call>'
    const calls = parseInlineToolCalls(content)
    expect(calls.map((c) => c.name)).toEqual(['calculator', 'get_current_time'])
  })

  it('parses multiple bare JSON objects', () => {
    const calls = parseInlineToolCalls('{"tool":"calculator","arguments":{"expression":"1+1"}} {"tool":"web_search","args":{"query":"x"}}')
    expect(calls.length).toBe(2)
  })
})

describe('toolRegistry', () => {
  it('registers and unregisters tools by source', () => {
    const fake: ToolDefinition = {
      name: 'mcp__x__ping',
      source: 'mcp:x',
      description: 'ping',
      parameters: { type: 'object', properties: {} },
      handler: async () => ({ content: 'pong' }),
    }
    toolRegistry.register(fake)
    expect(toolRegistry.has('mcp__x__ping')).toBe(true)
    toolRegistry.unregisterSource('mcp:x')
    expect(toolRegistry.has('mcp__x__ping')).toBe(false)
  })

  it('exposes OpenAI tool schemas', () => {
    const schemas = toolRegistry.toOpenAITools(['calculator'])
    expect(schemas[0].type).toBe('function')
    expect(schemas[0].function.name).toBe('calculator')
  })
})
