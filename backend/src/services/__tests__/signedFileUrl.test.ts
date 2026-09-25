import { beforeAll, describe, expect, it, vi } from 'vitest'
import { createFileLink, verifyFileLink } from '../signedFileUrl'

/** Signed short-lived file links (audit P2 "Open in new tab"): payload+HMAC,
 * expiry-bounded, file-bound, timing-safe comparison. */

const OWNER = 'usr-abcdef123456'
const FILE = 'file-xyz789'

beforeAll(() => { process.env.JWT_SECRET ||= 'test-signing-secret' })

function parts(url: string): { p: string; s: string } {
  const q = new URLSearchParams(url.split('?')[1])
  return { p: q.get('p') || '', s: q.get('s') || '' }
}

describe('signedFileUrl', () => {
  it('round-trips a valid link to the owner identity', () => {
    const link = createFileLink(OWNER, FILE)
    const { p, s } = parts(link.url)
    const verified = verifyFileLink(p, s, FILE)
    expect(verified).not.toBeNull()
    expect(verified!.ownerId).toBe(OWNER)
    expect(verified!.fileId).toBe(FILE)
    expect(link.expiresIn).toBe(300)
  })

  it('rejects a link bound to a different file id', () => {
    const link = createFileLink(OWNER, FILE)
    const { p, s } = parts(link.url)
    expect(verifyFileLink(p, s, 'file-other')).toBeNull()
  })

  it('rejects tampered payloads and signatures', () => {
    const link = createFileLink(OWNER, FILE)
    const { p, s } = parts(link.url)
    const tamperedPayload = Buffer.from(`${OWNER}:file-hijack:9999999999999`).toString('base64url')
    expect(verifyFileLink(tamperedPayload, s, 'file-hijack')).toBeNull()
    expect(verifyFileLink(p, s.slice(0, -1) + (s.endsWith('A') ? 'B' : 'A'), FILE)).toBeNull()
    expect(verifyFileLink('', s, FILE)).toBeNull()
  })

  it('rejects expired links', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    const link = createFileLink(OWNER, FILE, 10_000)
    const { p, s } = parts(link.url)
    vi.setSystemTime(new Date('2026-01-01T00:00:11Z'))
    expect(verifyFileLink(p, s, FILE)).toBeNull()
    vi.useRealTimers()
  })
})
