/**
 * Short-lived signed links for private files ("Open in new tab" for
 * non-published artifacts). The link carries an opaque payload (owner, file,
 * expiry) plus an HMAC over it — no session, no Authorization header needed,
 * and the expiry bounds exposure to a few minutes. The MAC is bound to the
 * file id, so a link for one file cannot be replayed against another.
 */
import { createHmac, timingSafeEqual } from 'crypto'

const DEFAULT_TTL_MS = 5 * 60 * 1000

function secret(): string {
  const s = process.env.FILE_LINK_SECRET || process.env.JWT_SECRET || ''
  if (!s) throw new Error('Signed file links require FILE_LINK_SECRET or JWT_SECRET')
  return s
}

function mac(payload: string): string {
  return createHmac('sha256', secret()).update(payload).digest('base64url')
}

export interface FileLink {
  url: string
  expiresIn: number
}

/** Create a signed short-lived content link for an owned file. */
export function createFileLink(ownerId: string, fileId: string, ttlMs: number = DEFAULT_TTL_MS): FileLink {
  const exp = Date.now() + ttlMs
  const payload = Buffer.from(`${ownerId}:${fileId}:${exp}`, 'utf8').toString('base64url')
  const sig = mac(payload)
  return { url: `/api/files/${fileId}/content?p=${payload}&s=${sig}`, expiresIn: Math.floor(ttlMs / 1000) }
}

export interface VerifiedLink {
  ownerId: string
  fileId: string
  expiresAt: number
}

/** Verify a signed link against the file it is being used for. Returns the
 * owner identity (for the ownership-scoped read) or null when invalid,
 * expired, tampered, or bound to a different file. */
export function verifyFileLink(payload: string, sig: string, expectedFileId: string): VerifiedLink | null {
  if (!payload || !sig || !expectedFileId) return null
  // The MAC covers the opaque payload string itself (the same bytes that
  // were signed at creation) — never the decoded form.
  const expected = mac(payload)
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null
  let decoded: string
  try { decoded = Buffer.from(payload, 'base64url').toString('utf8') } catch { return null }
  const [ownerId, fileId, expStr] = decoded.split(':')
  if (!ownerId || fileId !== expectedFileId || !expStr) return null
  const expiresAt = Number(expStr)
  if (!Number.isFinite(expiresAt) || Date.now() > expiresAt) return null
  return { ownerId, fileId, expiresAt }
}
