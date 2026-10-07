import { describe, expect, it } from 'vitest'
import { applyMention, botsForMessage, followUpTargets, groupFanOut, mentionDraft } from '../namedBots'
import { balanceMarkdown, presentAssistantText, presentStatus, presentStreamError, stripInlineToolPayload } from '../assistantText'

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

describe('presentStatus', () => {
  it('strips tool JSON and the fallback heading, and says Stopped for an abort', () => {
    const raw = 'Looking\n{"tool":"web_search","args":{"query":"q"}}\nHere is what I found so far:\nDone'
    const text = presentStatus(raw)
    expect(text).toContain('Looking')
    expect(text).toContain('Done')
    expect(text).not.toMatch(/"tool"|here is what i found/i)
    expect(presentStatus('BodyStreamBuffer was aborted')).toBe('Stopped')
    expect(presentStatus('The model is busy')).toBe('The model is busy')
  })
})

describe('presentStreamError', () => {
  it('hides aborts and translates transport failures', () => {
    expect(presentStreamError('BodyStreamBuffer was aborted')).toBeNull()
    expect(presentStreamError('Failed to fetch')).toMatch(/connection dropped/i)
    expect(presentStreamError('The model is busy')).toBe('The model is busy')
  })
})

describe('groupFanOut', () => {
  it('persists the user row once and lets every later member skip it', () => {
    const plan = groupFanOut([{ id: 'h' }, { id: 'r' }, { id: 'b' }])
    expect(plan.map((b) => b.skipUserPersist)).toEqual([false, true, true])
    expect(plan.filter((b) => !b.skipUserPersist)).toHaveLength(1)
  })
})

describe('botsForMessage', () => {
  const members = [{ id: 'h', name: 'Helm' }, { id: 'r', name: 'Review' }, { id: 'b', name: 'Builder' }]
  it('returns every member, or only the mentioned bots, in mention order', () => {
    expect(botsForMessage('build it', members)).toHaveLength(3)
    expect(botsForMessage('hey @Helm only you', members).map((b) => b.id)).toEqual(['h'])
    expect(botsForMessage('@Helm ship it @Review', members).map((b) => b.id)).toEqual(['h', 'r'])
    expect(botsForMessage('@Re check this', members)).toHaveLength(0)
    expect(botsForMessage('@all the plan', members)).toHaveLength(3)
    expect(botsForMessage('@nobody thoughts?', members)).toHaveLength(0)
  })

  it('schedules one follow-up for a bot who has not spoken and ignores @all', () => {
    expect(followUpTargets('Ask @Review to check.', members, ['h']).map((b) => b.id)).toEqual(['r'])
    expect(followUpTargets('@all please weigh in', members, ['h'])).toHaveLength(0)
    expect(followUpTargets('@Helm again', members, ['h'])).toHaveLength(0)
    expect(mentionDraft('hey @He')?.query).toBe('He')
    expect(applyMention('hey @He', 'Helm')).toBe('hey @Helm ')
  })
})
