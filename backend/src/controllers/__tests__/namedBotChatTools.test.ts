import { describe, expect, it } from 'vitest'
import { namedBotChatTools, withBotScratch } from '../agentStream'

describe('named bot chat tools', () => {
  it('grants the intersection of the bot tools and the account tools, including remember_fact', () => {
    expect(namedBotChatTools(
      ['web_search', 'generate_image', 'web_search', 'not_a_tool'],
      ['web_search', 'web_fetch', 'remember_fact', 'calculator'],
    )).toEqual(['web_search', 'remember_fact'])
  })

  it('omits remember_fact when the account cannot use it', () => {
    expect(namedBotChatTools(['web_search', 'remember_fact'], ['web_search'])).toEqual(['web_search'])
  })

  it('puts the request botId on tool scratch', () => {
    expect(withBotScratch({ faceLockConsent: false }, 'bot-9')).toEqual({
      faceLockConsent: false,
      botId: 'bot-9',
    })
    expect(withBotScratch({ faceLockConsent: true }, undefined)).toEqual({ faceLockConsent: true })
  })
})
