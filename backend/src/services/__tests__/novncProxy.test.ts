import { describe, expect, it } from 'vitest'
import jwt from 'jsonwebtoken'
import { mintNovncWsToken, novncSandboxId } from '../novncProxy'
import { jwtSecret } from '../jwtSecret'

describe('novncProxy signed ws token', () => {
  it('parses sandbox id from the websockify path', () => {
    expect(novncSandboxId('/api/bot/novnc/abc123/websockify')).toBe('abc123')
    expect(novncSandboxId('/api/bot/novnc/abc123/websockify?token=x')).toBe('abc123')
    expect(novncSandboxId('/api/other')).toBeNull()
  })

  it('mints a short-lived token bound to user + sandbox', () => {
    const { token, expiresIn } = mintNovncWsToken('user-1', 'sbx99', 45)
    expect(expiresIn).toBe(45)
    const decoded = jwt.verify(token, jwtSecret(), { algorithms: ['HS256'] }) as {
      userId: string
      sandboxId: string
      purpose: string
    }
    expect(decoded).toMatchObject({ userId: 'user-1', sandboxId: 'sbx99', purpose: 'novnc-ws' })
  })
})
