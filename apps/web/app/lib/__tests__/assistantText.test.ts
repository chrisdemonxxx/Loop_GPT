import { describe, expect, it } from 'vitest'
import { botsForMessage } from '../namedBots'
import { balanceMarkdown, presentAssistantText, presentStreamError, stripInlineToolPayload } from '../assistantText'

describe('presentAssistantText', () => {
  it('strips tool-call tags, fences, and bare objects', () => {
    const raw = 'Hello\n<tool_call>{"tool":"create_document","arguments":{"content":"x"}}</tool_call>\n```json\n{"tool":"web_search","args":{"query":"q"}}\n```\n{"name":"execute_code","arguments":{"code":"1"}}\nDone'
    const text = presentAssistantText(raw)
    expect(text).toContain('Hello')
    expect(text).toContain('Done')
    expect(text).not.toContain('create_document')
    expect(text).not.toContain('"tool"')
  })

  it('drops the internal fallback heading and closes a dangling backtick', () => {
    expect(presentAssistantText('Here is what I found so far:\n\n- `index.html')).not.toMatch(/here is what i found/i)
    expect(balanceMarkdown('use `index.html').endsWith('`')).toBe(true)
  })

  it('keeps an ordinary json fence that is not a tool call', () => {
    const raw = '```json\n{"title":"Notes"}\n```'
    expect(stripInlineToolPayload(raw)).toContain('Notes')
  })
})

describe('presentStreamError', () => {
  it('hides aborts and translates transport failures', () => {
    expect(presentStreamError('BodyStreamBuffer was aborted')).toBeNull()
    expect(presentStreamError('Failed to fetch')).toMatch(/connection dropped/i)
    expect(presentStreamError('The model is busy')).toBe('The model is busy')
  })
})

describe('botsForMessage', () => {
  const members = [{ id: 'h', name: 'Helm' }, { id: 'r', name: 'Review' }]
  it('returns every member, or only the mentioned bot', () => {
    expect(botsForMessage('build it', members)).toHaveLength(2)
    expect(botsForMessage('hey @Helm only you', members).map((b) => b.id)).toEqual(['h'])
  })
})
