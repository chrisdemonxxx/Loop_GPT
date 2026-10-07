import { describe, it, expect, beforeAll } from 'vitest'
import { registerBuiltinTools } from '../index'
import { parseInlineToolCall, parseInlineToolCalls, permissionFor, previewLine, requiresInteractivePause, settleFinalAnswer, stripInlineToolPayload } from '../agentRuntime'
import { toolRegistry } from '../toolRegistry'
import type { ToolDefinition, ToolContext } from '../types'

beforeAll(() => registerBuiltinTools())

describe('run-mode approval gate (requiresInteractivePause)', () => {
  it('pauses only on approval-level tools in the default mode', () => {
    expect(requiresInteractivePause('approval', false, false)).toBe(true)
    expect(requiresInteractivePause('allow', false, false)).toBe(false)
  })
  it('step mode ("Ask first") pauses for EVERY tool, whatever its level', () => {
    expect(requiresInteractivePause('allow', true, false)).toBe(true)
    expect(requiresInteractivePause('approval', true, false)).toBe(true)
  })
  it('auto-approve (Accept edits) disables the gate entirely', () => {
    expect(requiresInteractivePause('approval', false, true)).toBe(false)
    expect(requiresInteractivePause('allow', true, true)).toBe(false)
  })
  it('resolves permission defaults from needsApproval flags', () => {
    // Unique names: other suites may have set overrides for real tools.
    expect(permissionFor('fresh_allow_tool_xyz')).toBe('allow')
    expect(permissionFor('fresh_approval_tool_xyz', true)).toBe('approval')
    expect(permissionFor('create_document', true)).toBe('allow')
    expect(permissionFor('execute_code', false)).toBe('approval')
  })
})

describe('stripInlineToolPayload', () => {
  it('removes tool-call tags, json fences, and bare objects', () => {
    const raw = [
      'Writing the page.',
      '<tool_call>{"tool":"calculator","arguments":{"expression":"1+1"}}</tool_call>',
      '```json',
      '{"tool":"web_search","arguments":{"query":"landing"}}',
      '```',
      '{"tool":"get_current_time","arguments":{}}',
    ].join('\n')
    const text = stripInlineToolPayload(raw)
    expect(text).toContain('Writing the page.')
    expect(text).not.toContain('"tool"')
    expect(text).not.toContain('calculator')
  })

  it('preview lines drop tool JSON and the internal heading', () => {
    const line = previewLine('Hello\n{"tool":"web_search","arguments":{"query":"q"}}\nHere is what I found so far:\nThe page is ready.')
    expect(line).toContain('Hello')
    expect(line).toContain('The page is ready.')
    expect(line).not.toMatch(/"tool"|here is what i found/i)
  })
})

describe('settleFinalAnswer', () => {
  it('keeps the prose under the internal heading instead of replacing the whole answer', () => {
    const text = settleFinalAnswer(
      'Here is what I found so far:\nThe page is ready.',
      'Web search is done.',
    )
    expect(text).toBe('The page is ready.')
    expect(text).not.toMatch(/here is what i found/i)
  })

  it('strips a hashed heading and tool JSON, and narrates only when nothing remains', () => {
    expect(settleFinalAnswer('## Here is what I found so far:\nThe page is ready.', 'Web search is done.')).toBe('The page is ready.')
    expect(settleFinalAnswer(
      '{"tool":"web_search","arguments":{"query":"q"}}\nHere is what I found so far:',
      'Web search is done.',
    )).toBe('Web search is done.')
    expect(settleFinalAnswer('', 'I hit a snag before I could finish. Ask me to continue and I will.')).toMatch(/hit a snag/)
  })
})

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
