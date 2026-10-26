import { describe, expect, it } from 'vitest'
import { appendWsToken } from '../BotScreen'

describe('BotScreen ws-token', () => {
  it('replaces a ws-token minted for the previous sandbox', () => {
    const wsUrl = 'wss://loop-gpt.cyou/api/bot/novnc/sbxNew/websockify?token=old-sandbox-token'
    const next = appendWsToken(wsUrl, 'fresh-token', 'token')
    const params = new URL(next).searchParams.getAll('token')
    expect(params).toEqual(['fresh-token'])
    expect(next).not.toContain('old-sandbox-token')
  })
})
