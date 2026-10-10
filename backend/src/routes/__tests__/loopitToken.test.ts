import type { Server } from 'node:http'
import express from 'express'
import jwt from 'jsonwebtoken'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const JWT_SECRET = vi.hoisted(() => {
  process.env.JWT_SECRET = 'loopit-token-route-test-secret'
  return 'loopit-token-route-test-secret'
})

const db = vi.hoisted(() => {
  const client = {
    user: { findUnique: vi.fn() },
    workspace: { findUnique: vi.fn() },
    workspaceMember: { findUnique: vi.fn(), findFirst: vi.fn() },
  }
  return { client, useDb: true }
})

vi.mock('../../services/prisma', () => ({
  get prisma() { return db.useDb ? db.client : null },
  get hasDb() { return db.useDb },
}))

import loopitRoutes from '../loopit'

let server: Server
let base: string
const savedEnv = {
  secret: process.env.LOOPIT_IDENTITY_SECRET,
  kid: process.env.LOOPIT_IDENTITY_KID,
}

beforeAll(async () => {
  const app = express()
  app.use(express.json())
  app.use('/api/loopit', loopitRoutes)
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve) })
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})
afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())) })

beforeEach(() => {
  db.useDb = true
  db.client.user.findUnique.mockReset()
  db.client.workspace.findUnique.mockReset()
  db.client.workspaceMember.findUnique.mockReset()
  db.client.workspaceMember.findFirst.mockReset()
  db.client.user.findUnique.mockResolvedValue({ sessionInvalidatedAt: null })
  process.env.LOOPIT_IDENTITY_SECRET = 'route-test-identity-secret-at-least-32'
  process.env.LOOPIT_IDENTITY_KID = 'route-kid'
  delete process.env.LOOPIT_IDENTITY_ISSUER
  delete process.env.LOOPIT_IDENTITY_AUDIENCE
})
afterEach(() => {
  if (savedEnv.secret === undefined) delete process.env.LOOPIT_IDENTITY_SECRET
  else process.env.LOOPIT_IDENTITY_SECRET = savedEnv.secret
  if (savedEnv.kid === undefined) delete process.env.LOOPIT_IDENTITY_KID
  else process.env.LOOPIT_IDENTITY_KID = savedEnv.kid
})

function session(userId = 'user-1'): string {
  return jwt.sign({ userId }, JWT_SECRET, { expiresIn: '1h' })
}

function call(opts: { token?: string; cookie?: boolean; body?: unknown; raw?: string } = {}) {
  const headers: Record<string, string> = {}
  if (opts.cookie) headers.cookie = `loop_session=${encodeURIComponent(opts.token ?? session())}`
  else if (opts.token !== '') headers.authorization = `Bearer ${opts.token ?? session()}`
  if (opts.raw !== undefined || opts.body !== undefined) headers['content-type'] = 'application/json'
  return fetch(`${base}/api/loopit/token`, {
    method: 'POST',
    headers,
    body: opts.raw !== undefined ? opts.raw : opts.body === undefined ? '{}' : JSON.stringify(opts.body),
  })
}

describe('POST /api/loopit/token', () => {
  it('requires a Loop-GPT session', async () => {
    const res = await call({ token: '' })
    expect(res.status).toBe(401)
  })

  it('accepts the httpOnly session cookie', async () => {
    db.client.workspace.findUnique.mockResolvedValue({ id: 'personal-user-1' })
    db.client.workspaceMember.findUnique.mockResolvedValue({ role: 'owner' })
    const res = await call({ cookie: true, body: {} })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.token_type).toBe('bearer')
    expect(body.org).toBe('personal-user-1')
    expect(body.role).toBe('owner')
    expect(body.expires_in).toBe(900)
    expect(typeof body.access_token).toBe('string')
    expect(res.headers.get('cache-control')).toBe('no-store')
    // The web client's createTokenStore parses these two fields; they must
    // carry the same token and a real expiry or the Build page dies offline.
    expect(body.token).toBe(body.access_token)
    expect(typeof body.token).toBe('string')
    expect(body.token.length).toBeGreaterThan(0)
    const parsedExpiry = Date.parse(String(body.expiresAt))
    expect(Number.isNaN(parsedExpiry)).toBe(false)
    expect(parsedExpiry).toBeGreaterThan(Date.now())
  })

  it('accepts a bearer token and maps an editor to member', async () => {
    db.client.workspaceMember.findUnique.mockResolvedValue({ role: 'editor', workspaceId: 'ws-shared' })
    const res = await call({ body: { workspaceId: 'ws-shared' } })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.org).toBe('ws-shared')
    expect(body.role).toBe('member')
    const payload = JSON.parse(Buffer.from(String(body.access_token).split('.')[1], 'base64url').toString('utf8'))
    expect(payload).toMatchObject({ sub: 'user-1', org: 'ws-shared', role: 'member', aud: 'loopit-control-plane', iss: 'loopit-gateway' })
    expect(JSON.parse(Buffer.from(String(body.access_token).split('.')[0], 'base64url').toString('utf8')).kid).toBe('route-kid')
  })

  it('defaults to the personal workspace ahead of an older membership', async () => {
    db.client.workspace.findUnique.mockResolvedValue({ id: 'personal-user-1' })
    db.client.workspaceMember.findUnique.mockResolvedValue({ role: 'owner' })
    const res = await call({ body: {} })
    expect(res.status).toBe(200)
    expect(db.client.workspaceMember.findFirst).not.toHaveBeenCalled()
    expect((await res.json()).org).toBe('personal-user-1')
  })

  it('falls back to the oldest membership when there is no personal workspace', async () => {
    db.client.workspace.findUnique.mockResolvedValue(null)
    db.client.workspaceMember.findFirst.mockResolvedValue({ workspaceId: 'ws-old', role: 'viewer' })
    const res = await call({ body: {} })
    expect(res.status).toBe(200)
    expect((await res.json()).role).toBe('viewer')
    expect(db.client.workspaceMember.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId: 'user-1' },
    }))
  })

  it('rejects a non-member with 403', async () => {
    db.client.workspaceMember.findUnique.mockResolvedValue(null)
    const res = await call({ body: { workspaceId: 'ws-other' } })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'Not a member of this workspace' })
  })

  it('returns 503 when the signing secret or kid is unset', async () => {
    delete process.env.LOOPIT_IDENTITY_SECRET
    delete process.env.LOOPIT_IDENTITY_KID
    db.client.workspaceMember.findUnique.mockResolvedValue({ role: 'owner', workspaceId: 'ws-1' })
    const res = await call({ body: { workspaceId: 'ws-1' } })
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.error).toMatch(/LOOPIT_IDENTITY_SECRET/)
    expect(JSON.stringify(body)).not.toContain('route-test')
  })

  it('returns 503 when the database is not configured', async () => {
    db.useDb = false
    const res = await call({ body: { workspaceId: 'ws-1' } })
    expect(res.status).toBe(503)
  })

  it('returns 400 for a malformed body', async () => {
    const res = await call({ body: { workspaceId: 12 } })
    expect(res.status).toBe(400)
  })
})
