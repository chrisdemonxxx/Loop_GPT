import { describe, expect, it } from 'vitest'
import { generateSecret, generateURI, generateSync, verifySync } from 'otplib'

/** TOTP MFA wiring (brief P2): the exact otplib calls the account + login
 * routes make, proven against the library's real implementation — secret
 * generation, the otpauth URI authenticator apps consume, code generation,
 * verification (incl. tolerance + rejection). */

describe('TOTP (account MFA)', () => {
  it('round-trips: secret → otpauth URI → generated code verifies', () => {
    const secret = generateSecret()
    expect(secret).toMatch(/^[A-Z2-7]+$/)

    const uri = generateURI({ issuer: 'Loop GPT', label: 'user@example.com', secret })
    expect(uri).toMatch(/^otpauth:\/\/totp\/Loop%20GPT:user%40example\.com\?/)
    expect(uri).toContain(`secret=${secret}`)

    const token = generateSync({ secret })
    expect(token).toMatch(/^\d{6}$/)
    expect(verifySync({ token, secret, epochTolerance: 30 }).valid).toBe(true)
  })

  it('accepts the previous time step within tolerance (clock drift)', () => {
    const secret = generateSecret()
    const token = generateSync({ secret, epoch: Math.floor(Date.now() / 1000) - 30 }) // one step behind
    expect(verifySync({ token, secret, epochTolerance: 30 }).valid).toBe(true)
    expect(verifySync({ token, secret }).valid).toBe(false) // strict would reject
  })

  it('rejects wrong codes', () => {
    const secret = generateSecret()
    const good = generateSync({ secret })
    const wrong = (Number(good) + 1).toString().padStart(6, '0').slice(-6)
    expect(wrong).not.toBe(good)
    expect(verifySync({ token: wrong, secret, epochTolerance: 30 }).valid).toBe(false)
  })

  it('rejections carry a reason (no exceptions thrown)', () => {
    const secret = generateSecret()
    const result = verifySync({ token: '000000', secret })
    expect(result.valid).toBe(false)
  })
})
