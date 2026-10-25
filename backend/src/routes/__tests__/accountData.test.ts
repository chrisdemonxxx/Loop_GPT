import type { Server } from 'node:http'
import express from 'express'
import jwt from 'jsonwebtoken'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { errorLogger } from '../../middleware/errorLogger'

/**
 * GET /api/account/export and DELETE /api/account. The settings tab downloads
 * the export as a blob and treats any successful delete as done, then clears
 * the browser session itself.
 */
const secret = vi.hoisted(() => {
  process.env.JWT_SECRET = 'account-data-route-test-secret-32'
  return 'account-data-route-test-secret-32'
})

const userId = 'account-export-user'
const otherUserId = 'account-other-user'
const passwordHash = 'scrypt-hash-do-not-export'
const totpSecret = 'JBSWY3DPEHPK3PXP'
const shareToken = 'share-token-do-not-export'
const imagePath = '/var/lib/loop/secret-image-path.png'
const createdAt = new Date('2026-01-02T03:04:05.000Z')

const fixtures = vi.hoisted(() => ({
  hasDb: true,
  db: {
    user: { findUnique: vi.fn(), delete: vi.fn() },
    conversation: { findMany: vi.fn() },
  },
}))

vi.mock('../../services/prisma', () => ({
  get prisma() { return fixtures.hasDb ? fixtures.db : null },
  get hasDb() { return fixtures.hasDb },
}))

vi.mock('../../services/email', () => ({
  voucherRedeemedEmail: vi.fn(),
  welcomeEmail: vi.fn(),
  verifyEmail: vi.fn(),
  resetPasswordEmail: vi.fn(),
  alertEmail: vi.fn(),
}))

let server: Server
let base: string

beforeAll(async () => {
  const account = await import('../account')
  const app = express()
  app.use(express.json())
  app.use('/api/account', account.default)
  app.use(errorLogger)
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing loopback listener')
  base = `http://127.0.0.1:${address.port}`
})

afterAll(async () => {
  if (server) await new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve())
  })
})

function tokenFor(id: string) {
  return jwt.sign({ userId: id }, secret, { expiresIn: '1h' })
}

function profileRow(id: string) {
  return {
    id,
    email: id === userId ? 'ada@example.invalid' : 'other@example.invalid',
    name: id === userId ? 'Ada' : 'Other',
    role: 'user',
    plan: 'pro',
    unlimited: false,
    emailVerified: true,
    createdAt,
    updatedAt: createdAt,
    credits: 12,
    imageCredits: 3,
    creditsResetAt: createdAt,
    memoryEnabled: true,
    consentTraining: false,
    totpEnabled: true,
    tokensInTotal: 10n,
    tokensOutTotal: 20n,
    imagesTotal: 1,
    messagesTotal: 4,
    lastActiveAt: createdAt,
    password: passwordHash,
    totpSecret,
  }
}

function conversationRow(ownerId: string) {
  return {
    id: `conv-${ownerId}`,
    title: 'Hello',
    createdAt,
    updatedAt: createdAt,
    incognito: false,
    pinned: true,
    kind: 'chat',
    botId: null,
    botIds: null,
    activeLeafId: `msg-${ownerId}-2`,
    shareToken,
    userId: ownerId,
    messages: [{
      id: `msg-${ownerId}-1`,
      role: 'user',
      content: `hello from ${ownerId}`,
      createdAt,
      messageType: 'text',
      imageUrl: null,
      imagePath,
      toolUsed: null,
      metadata: { note: 'kept' },
      parentId: null,
      authorBotId: null,
    }],
  }
}

beforeEach(() => {
  fixtures.hasDb = true
  fixtures.db.user.findUnique.mockReset()
  fixtures.db.user.delete.mockReset()
  fixtures.db.conversation.findMany.mockReset()
  fixtures.db.user.findUnique.mockImplementation(async (args: { where: { id: string }; select?: Record<string, boolean> }) => {
    if (args.select?.sessionInvalidatedAt && !args.select.email) return { sessionInvalidatedAt: null }
    return profileRow(args.where.id)
  })
  fixtures.db.user.delete.mockImplementation(async ({ where }: { where: { id: string } }) => ({ id: where.id }))
  fixtures.db.conversation.findMany.mockImplementation(async ({ where }: { where: { userId: string } }) => [conversationRow(where.userId)])
})

function request(path: string, method: string, bearer?: string) {
  return fetch(`${base}${path}`, {
    method,
    headers: bearer ? { Authorization: `Bearer ${bearer}` } : {},
  })
}

function selectedKeys(value: unknown, found = new Set<string>()): Set<string> {
  if (!value || typeof value !== 'object') return found
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    found.add(key)
    selectedKeys(child, found)
  }
  return found
}

describe('GET /api/account/export', () => {
  it('requires a signed-in user', async () => {
    const response = await request('/api/account/export', 'GET')
    expect(response.status).toBe(401)
    expect(fixtures.db.conversation.findMany).not.toHaveBeenCalled()
  })

  it('downloads the signed-in profile, conversations, and messages', async () => {
    const response = await request('/api/account/export', 'GET', tokenFor(userId))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('application/json')
    expect(response.headers.get('content-disposition')).toBe('attachment; filename="loop-gpt-export.json"')
    expect(response.headers.get('cache-control')).toBe('no-store')

    const body = await response.json()
    expect(body.exportedAt).toEqual(expect.any(String))
    expect(body.profile).toMatchObject({
      id: userId,
      email: 'ada@example.invalid',
      name: 'Ada',
      plan: 'pro',
      totpEnabled: true,
      credits: 12,
      usage: { tokensIn: '10', tokensOut: '20', images: 1, messages: 4 },
    })
    expect(body.conversations).toEqual([{
      id: `conv-${userId}`,
      title: 'Hello',
      createdAt: createdAt.toISOString(),
      updatedAt: createdAt.toISOString(),
      incognito: false,
      pinned: true,
      kind: 'chat',
      botId: null,
      botIds: null,
      activeLeafId: `msg-${userId}-2`,
      messages: [{
        id: `msg-${userId}-1`,
        role: 'user',
        content: `hello from ${userId}`,
        createdAt: createdAt.toISOString(),
        messageType: 'text',
        imageUrl: null,
        toolUsed: null,
        metadata: { note: 'kept' },
        parentId: null,
        authorBotId: null,
      }],
    }])

    const serialized = JSON.stringify(body)
    expect(serialized).not.toContain(passwordHash)
    expect(serialized).not.toContain(totpSecret)
    expect(serialized).not.toContain(shareToken)
    expect(serialized).not.toContain(imagePath)
    expect(body.profile.password).toBeUndefined()
    expect(body.profile.totpSecret).toBeUndefined()

    const profileQuery = fixtures.db.user.findUnique.mock.calls.map(call => call[0]).find(call => call.select?.email)
    const conversationQuery = fixtures.db.conversation.findMany.mock.calls[0][0]
    const keys = new Set([...selectedKeys(profileQuery.select), ...selectedKeys(conversationQuery.select)])
    expect(profileQuery.where).toEqual({ id: userId })
    expect(conversationQuery.where).toEqual({ userId })
    expect(keys.has('password')).toBe(false)
    expect(keys.has('totpSecret')).toBe(false)
  })

  it('exports only the signed-in user', async () => {
    const response = await request('/api/account/export', 'GET', tokenFor(otherUserId))
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.profile.id).toBe(otherUserId)
    expect(body.profile.email).toBe('other@example.invalid')
    expect(body.conversations[0].id).toBe(`conv-${otherUserId}`)
    expect(body.conversations[0].messages[0].content).toBe(`hello from ${otherUserId}`)
    expect(JSON.stringify(body)).not.toContain(userId)
  })

  it('reports that export needs a database without looking like a missing route', async () => {
    fixtures.hasDb = false
    const response = await request('/api/account/export', 'GET', tokenFor(userId))
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: 'Account export requires a database.' })
    expect(fixtures.db.user.findUnique).not.toHaveBeenCalled()
    expect(fixtures.db.conversation.findMany).not.toHaveBeenCalled()
  })
})

describe('DELETE /api/account', () => {
  it('requires a signed-in user', async () => {
    const response = await request('/api/account', 'DELETE')
    expect(response.status).toBe(401)
    expect(fixtures.db.user.delete).not.toHaveBeenCalled()
  })

  it('deletes the signed-in user and returns success', async () => {
    const response = await request('/api/account', 'DELETE', tokenFor(userId))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('set-cookie')).toContain('loop_session=')
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0')
    expect(fixtures.db.user.delete).toHaveBeenCalledTimes(1)
    expect(fixtures.db.user.delete).toHaveBeenCalledWith({ where: { id: userId } })
    expect(fixtures.db.conversation.findMany).not.toHaveBeenCalled()
  })

  it('deletes only the signed-in user', async () => {
    const response = await request('/api/account', 'DELETE', tokenFor(otherUserId))
    expect(response.status).toBe(200)
    expect(fixtures.db.user.delete).toHaveBeenCalledWith({ where: { id: otherUserId } })
  })

  it('still succeeds when the user row is already gone', async () => {
    fixtures.db.user.delete.mockRejectedValue(Object.assign(new Error('Record to delete does not exist.'), { code: 'P2025' }))
    const response = await request('/api/account', 'DELETE', tokenFor(userId))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
  })

  it('does not report success when deletion fails', async () => {
    fixtures.db.user.delete.mockRejectedValue(Object.assign(new Error('foreign key'), { code: 'P2003' }))
    const response = await request('/api/account', 'DELETE', tokenFor(userId))
    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ error: 'Internal server error' })
    expect(response.headers.get('set-cookie')).toBeNull()
  })

  it('reports that deletion needs a database without looking like a missing route', async () => {
    fixtures.hasDb = false
    const response = await request('/api/account', 'DELETE', tokenFor(userId))
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: 'Account deletion requires a database.' })
    expect(fixtures.db.user.delete).not.toHaveBeenCalled()
  })
})
