import { describe, expect, it } from 'vitest'
import { STARTER_BOTS, botsForMessage, greeting, narrateSteps, primaryDeleteRefusal, rosterAction, shouldPersistUserMessage } from '../botRoster'

describe('named bot roster', () => {
  it('ships Loop Bot plus the Grok-style starters', () => {
    expect(STARTER_BOTS.map((b) => b.name)).toEqual(['Loop Bot', 'Helm', 'Review', 'Builder', 'Spec', 'Release'])
    expect(STARTER_BOTS.filter((b) => b.isPrimary)).toHaveLength(1)
  })

  it('greets with the bot name', () => {
    expect(greeting('Ada Lovelace', 'Helm')).toBe("Hi Ada, I'm Helm — where do you want me to help?")
    expect(greeting(null, 'Review')).toBe("Hi there, I'm Review — where do you want me to help?")
  })

  it('fans a message out to every member unless an @mention names one', () => {
    const members = [
      { id: '1', name: 'Helm' },
      { id: '2', name: 'Review' },
    ]
    expect(botsForMessage('ship the landing page', members).map((b) => b.name)).toEqual(['Helm', 'Review'])
    expect(botsForMessage(' @Review check the copy', members).map((b) => b.name)).toEqual(['Review'])
    expect(botsForMessage('@nobody thoughts?', members)).toHaveLength(2)
  })

  it('seeds an empty roster, repairs a missing primary, and refuses to delete Loop Bot', () => {
    expect(rosterAction(0, false)).toBe('seed')
    expect(rosterAction(3, false)).toBe('repair-primary')
    expect(rosterAction(3, true)).toBe('keep')
    expect(primaryDeleteRefusal(true)).toMatch(/primary agent/)
    expect(primaryDeleteRefusal(false)).toBeNull()
  })

  it('stores a group user message once', () => {
    const members = [{ id: '1' }, { id: '2' }]
    const flags = members.map((_, i) => !shouldPersistUserMessage({ skipUserPersist: i > 0 }))
    expect(flags.filter(Boolean)).toHaveLength(1)
    expect(shouldPersistUserMessage({ regenerateOf: 'm1', skipUserPersist: false })).toBe(false)
    expect(shouldPersistUserMessage({})).toBe(true)
  })

  it('narrates steps in sentences', () => {
    const text = narrateSteps([{ tool: 'create_document', result: 'ok' }])
    expect(text.toLowerCase()).not.toContain('create_document')
    expect(text.length).toBeGreaterThan(8)
  })
})
