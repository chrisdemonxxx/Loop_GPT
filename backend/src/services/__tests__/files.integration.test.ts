import { randomUUID } from 'crypto'
import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import type { Server } from 'http'
import express from 'express'
import jwt from 'jsonwebtoken'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// External services never run in this suite. HTTP, PostgreSQL, local storage,
// authentication, ownership checks, and document generation remain real.
vi.mock('../email', () => ({ welcomeEmail: vi.fn(async () => {}), verifyEmail: vi.fn(async () => {}) }))
const model = vi.hoisted(() => ({ image: vi.fn(), vision: vi.fn(async () => ({ choices: [{ message: { content: 'Mocked vision answer' } }] })), runAgent: vi.fn(async (options: any) => {
  await options.beforeDispatch?.()
  options.ctx.emit({ type: 'final', content: 'Mocked model response' })
  return { content: 'Mocked model response', steps: [], toolsUsed: [] }
}) }))
vi.mock('../../agent/agentRuntime', () => ({ runAgent: model.runAgent }))
vi.mock('../../agent/llmClient', () => ({ createClient: vi.fn(() => ({ chat: { completions: { create: model.vision } } })) }))
vi.mock('../imageApi', () => ({ imageApiService: { generateImage: model.image } }))
import { prisma } from '../prisma'
import authRouter from '../../routes/auth'
import conversationsRouter from '../../routes/conversations'
import messagesRouter from '../../routes/messages'
import agentRouter from '../../routes/agent'
import v1Router from '../../routes/v1'
import { filesRouter, imageUploadRouter, rejectLegacyUploads } from '../../routes/files'
import { storePrivateFile, readOwnedFile, readOwnedImage, deleteOwnedFile } from '../privateFiles'
import { getOrCreateConversation } from '../chatStore'
import { createApiKey, revokeApiKey } from '../apiKeys'
import { createDocumentTool } from '../../agent/tools/createDocument'
import { createClient } from '../../agent/llmClient'

const db = prisma!
const prefix = `files-${randomUUID()}`
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
let root: string
let previousRoot: string | undefined
let server: Server
let base: string
let alice: { id: string }
let bob: { id: string }
let conversation: { id: string }
let secondConversation: { id: string }
function bearer(userId: string) { return { Authorization: `Bearer ${jwt.sign({ userId }, process.env.JWT_SECRET!)}` } }
function imageForm(bytes = png, mime = 'image/png') {
  const form = new FormData()
  form.append('image', new Blob([new Uint8Array(bytes)], { type: mime }), 'image.png')
  return form
}
async function ownedImage() {
  return storePrivateFile({ userId: alice.id, conversationId: conversation.id, name: 'sample.png', mimeType: 'image/png', purpose: 'upload', buffer: png })
}

beforeAll(async () => {
  vi.stubEnv('IMAGE_API_URL', 'http://127.0.0.1:8081') // Network is mocked; never inherit operator sidecar configuration.
  previousRoot = process.env.PRIVATE_FILES_DIR
  model.image.mockResolvedValue({ image_base64: png.toString('base64'), model: 'test-image', success: true })
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'loop-private-files-test-'))
  process.env.PRIVATE_FILES_DIR = root
  alice = await db.user.create({ data: { id: `${prefix}-alice`, email: `${prefix}-alice@example.test`, password: 'fixture-only', name: 'Alice' } })
  bob = await db.user.create({ data: { id: `${prefix}-bob`, email: `${prefix}-bob@example.test`, password: 'fixture-only', name: 'Bob' } })
  conversation = await db.conversation.create({ data: { userId: alice.id, title: 'Private project' } })
  secondConversation = await db.conversation.create({ data: { userId: alice.id, title: 'Other project' } })
  const app = express()
  app.use(express.json())
  app.use('/api/auth', authRouter)
  app.use('/api/files', filesRouter)
  app.use('/api/conversations', imageUploadRouter, conversationsRouter, messagesRouter, agentRouter)
  app.use('/api/agent', agentRouter)
  app.use('/v1', v1Router)
  app.use('/uploads', rejectLegacyUploads)
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing test server port')
  base = `http://127.0.0.1:${address.port}`
})

afterAll(async () => {
  try {
    if (server) await new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close((error) => error ? reject(error) : resolve()) })
    // Only this suite's paid-request fixtures; durable holds intentionally block
    // account deletion until their ledger/reservation records are handled.
    await db.apiUsage.deleteMany({ where: { userId: { startsWith: prefix } } })
    await db.apiReservation.deleteMany({ where: { userId: { startsWith: prefix } } })
    await db.user.deleteMany({ where: { OR: [{ id: { startsWith: prefix } }, { email: { startsWith: prefix } }] } })
    if (root) await fs.rm(root, { recursive: true, force: true })
  } finally {
    if (previousRoot === undefined) delete process.env.PRIVATE_FILES_DIR
    else process.env.PRIVATE_FILES_DIR = previousRoot
    vi.unstubAllEnvs()
    await db.$disconnect()
  }
})

describe('private file and account isolation over HTTP/PostgreSQL', () => {
  it('never provisions a signup as admin, even for ADMIN_EMAIL', async () => {
    const previous = process.env.ADMIN_EMAIL
    const email = `${prefix}-signup@example.test`
    process.env.ADMIN_EMAIL = email
    try {
      const res = await fetch(`${base}/api/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password: 'test-only-strong-password', name: 'Signup fixture' }) })
      expect(res.status).toBe(200)
      expect((await res.json() as any).user.role).toBe('user')
      expect((await db.user.findUniqueOrThrow({ where: { email } })).role).toBe('user')
    } finally { if (previous === undefined) delete process.env.ADMIN_EMAIL; else process.env.ADMIN_EMAIL = previous }
  })

  it('does not allow a signed token without userId to read conversations', async () => {
    const res = await fetch(`${base}/api/conversations`, { headers: { Authorization: `Bearer ${jwt.sign({}, process.env.JWT_SECRET!)}` } })
    expect(res.status).toBe(401)
  })

  it('isolates conversation reads, messages, updates and deletes', async () => {
    for (const suffix of ['', '/messages']) {
      const res = await fetch(`${base}/api/conversations/${conversation.id}${suffix}`, { headers: bearer(bob.id) })
      expect(res.status).toBe(404)
    }
    for (const method of ['PATCH', 'DELETE']) {
      const res = await fetch(`${base}/api/conversations/${conversation.id}`, { method, headers: { ...bearer(bob.id), 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Changed' }) })
      expect(res.status).toBe(404)
    }
    expect((await db.conversation.findUniqueOrThrow({ where: { id: conversation.id } })).title).toBe('Private project')
  })

  it('does not bypass ownership for the explicit development identity', async () => {
    const env = process.env.NODE_ENV; const enabled = process.env.ENABLE_DEV_MODE
    process.env.NODE_ENV = 'development'; process.env.ENABLE_DEV_MODE = 'true'
    try {
      expect((await fetch(`${base}/api/conversations/${conversation.id}/messages`)).status).toBe(404)
    } finally { process.env.NODE_ENV = env; process.env.ENABLE_DEV_MODE = enabled }
  })

  it('does not create arbitrary caller-chosen conversation IDs', async () => {
    expect(await getOrCreateConversation(alice.id, `${prefix}-missing`, 'Unknown')).toBeNull()
    expect(await getOrCreateConversation(bob.id, conversation.id, 'Foreign')).toBeNull()
  })

  it('uploads into a new conversation rather than reusing an existing one', async () => {
    const res = await fetch(`${base}/api/conversations/new/upload-image`, { method: 'POST', headers: bearer(alice.id), body: imageForm() })
    const body: any = await res.json()
    expect(res.status, JSON.stringify(body)).toBe(201)
    expect(body.conversationId).not.toBe(conversation.id)
    expect(body.conversationId).not.toBe(secondConversation.id)
    expect(body.attachmentId).toMatch(/^[0-9a-f-]{36}$/)
    expect(body.imagePath).toBeUndefined()
    expect(body.url).toBe(`/api/files/${body.attachmentId}/content`)
  })

  it('rejects foreign conversation uploads before storing bytes', async () => {
    const before = await fs.readdir(root)
    const res = await fetch(`${base}/api/conversations/${conversation.id}/upload-image`, { method: 'POST', headers: bearer(bob.id), body: imageForm() })
    expect(res.status).toBe(404)
    expect(await fs.readdir(root)).toEqual(before)
  })

  it('rejects forged image content and oversized uploads', async () => {
    const invalid = await fetch(`${base}/api/conversations/${conversation.id}/upload-image`, { method: 'POST', headers: bearer(alice.id), body: imageForm(Buffer.from('<script>bad</script>')) })
    expect(invalid.status).toBe(415)
    const oversized = await fetch(`${base}/api/conversations/${conversation.id}/upload-image`, { method: 'POST', headers: bearer(alice.id), body: imageForm(Buffer.alloc(10 * 1024 * 1024 + 1)) })
    expect(oversized.status).toBe(413)
  })

  it('protects content with ownership, no-store, and download-only headers', async () => {
    const file = await ownedImage()
    expect((await fetch(`${base}/api/files/${file.id}/content`)).status).toBe(401)
    expect((await fetch(`${base}/api/files/${file.id}/content`, { headers: bearer(bob.id) })).status).toBe(404)
    const res = await fetch(`${base}/api/files/${file.id}/content`, { headers: bearer(alice.id) })
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toContain('no-store')
    expect(res.headers.get('content-disposition')).toContain('attachment;')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('content-security-policy')).toContain('sandbox')
    expect(Buffer.from(await res.arrayBuffer())).toEqual(png)
  })

  it('allows the owner API key and immediately rejects a revoked key', async () => {
    const file = await ownedImage()
    const key = await createApiKey(alice.id, 'Integration key')
    const headers = { Authorization: `Bearer ${key.key}` }
    expect((await fetch(`${base}/api/files/${file.id}/content`, { headers })).status).toBe(200)
    await revokeApiKey(alice.id, key.id)
    expect((await fetch(`${base}/api/files/${file.id}/content`, { headers })).status).toBe(401)
  })

  it('prevents attaching a file to another conversation even for the same user', async () => {
    const file = await ownedImage()
    await expect(readOwnedImage(alice.id, secondConversation.id, file.id)).rejects.toMatchObject({ status: 404 })
    await expect(readOwnedImage(bob.id, conversation.id, file.id)).rejects.toMatchObject({ status: 404 })
  })

  it('rejects server paths in both message APIs before model invocation', async () => {
    model.runAgent.mockClear()
    for (const endpoint of [`/api/agent/${conversation.id}/stream`, `/api/conversations/${conversation.id}/stream`, `/api/conversations/${conversation.id}/messages`]) {
      const res = await fetch(`${base}${endpoint}`, { method: 'POST', headers: { ...bearer(alice.id), 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'read it', imagePath: '/etc/passwd' }) })
      expect(res.status).toBe(400)
    }
    expect(model.runAgent).not.toHaveBeenCalled()
  })

  it('resolves an owned attachment into image bytes for the model', async () => {
    const file = await ownedImage()
    model.runAgent.mockClear()
    const res = await fetch(`${base}/api/agent/${conversation.id}/stream`, { method: 'POST', headers: { ...bearer(alice.id), 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'Describe this', attachmentId: file.id, mode: 'chat' }) })
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('Mocked model response')
    const current = model.runAgent.mock.calls[0][0].messages.at(-1)
    expect(current.content[1].image_url.url).toBe(`data:image/png;base64,${png.toString('base64')}`)
  })

  it('blocks a foreign attachment before invoking the agent', async () => {
    const file = await ownedImage(); model.runAgent.mockClear()
    const res = await fetch(`${base}/api/agent/${conversation.id}/stream`, { method: 'POST', headers: { ...bearer(bob.id), 'Content-Type': 'application/json' }, body: JSON.stringify({ content: 'Read it', attachmentId: file.id }) })
    expect(res.status).toBe(404)
    expect(model.runAgent).not.toHaveBeenCalled()
  })

  it('sends owned image bytes through the legacy vision route without filesystem paths', async () => {
    const file = await ownedImage(); model.vision.mockClear()
    const res = await fetch(`${base}/api/conversations/${conversation.id}/messages`, { method: 'POST', headers: { ...bearer(alice.id), 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'Describe it', attachmentId: file.id, tool: 'vision-chat' }) })
    expect(res.status).toBe(200)
    const body: any = await res.json()
    expect(body.assistantMessage.content).toBe('Mocked vision answer')
    expect(body.userMessage.imageUrl).toBe(`/api/files/${file.id}/content`)
    const call = vi.mocked(model.vision).mock.calls[0] as any[]
    expect(call[0].messages[0].content[1].image_url.url).toBe(`data:image/png;base64,${png.toString('base64')}`)
    expect(call[0].image_path).toBeUndefined()
  })

  it('publishes API media into private rather than anonymous storage', async () => {
    const key = await createApiKey(alice.id, 'Media publisher')
    const res = await fetch(`${base}/v1/media/publish`, { method: 'POST', headers: { Authorization: `Bearer ${key.key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ b64: png.toString('base64'), mime: 'image/png', name: 'sample.png' }) })
    const body: any = await res.json()
    expect(res.status).toBe(200)
    expect(body.url).toContain(`/api/files/${body.id}/content`)
    expect((await fetch(`${base}/api/files/${body.id}/content`)).status).toBe(401)
    expect((await readOwnedFile(alice.id, body.id)).buffer).toEqual(png)
  })

  it('stores legacy image-generation results as private artifacts', async () => {
    const res = await fetch(`${base}/api/conversations/${conversation.id}/messages`, { method: 'POST', headers: { ...bearer(alice.id), 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'Generate a test image', tool: 'generate-image' }) })
    const body: any = await res.json()
    expect(res.status).toBe(200)
    const artifact = body.assistantMessage.metadata.artifacts[0]
    expect(body.assistantMessage.imageUrl).toBe(`/api/files/${artifact.id}/content`)
    expect(body.assistantMessage.imagePath).toBeNull()
    expect((await readOwnedFile(alice.id, artifact.id)).buffer).toEqual(png)
    await expect(readOwnedFile(bob.id, artifact.id)).rejects.toMatchObject({ status: 404 })
  })

  it('creates a real private CSV artifact for its owner', async () => {
    const result = await createDocumentTool.handler({ format: 'csv', filename: 'results', rows: [['a', 'b'], [1, 2]] },
      { userId: alice.id, conversationId: conversation.id, emit: () => {}, scratch: {} })
    const fileId = result.data!.artifact.id
    expect((await readOwnedFile(alice.id, fileId)).buffer.toString()).toContain('1,2')
    await expect(readOwnedFile(bob.id, fileId)).rejects.toMatchObject({ status: 404 })
  })

  it('detects altered stored bytes', async () => {
    const file = await ownedImage()
    await fs.writeFile(path.join(root, file.id), Buffer.alloc(png.length))
    await expect(readOwnedFile(alice.id, file.id)).rejects.toMatchObject({ status: 409 })
  })

  it('rejects symlink replacement of owned storage', async (context) => {
    const file = await ownedImage()
    const target = path.join(root, `${prefix}-target`)
    await fs.writeFile(target, png)
    await fs.unlink(path.join(root, file.id))
    try { await fs.symlink(target, path.join(root, file.id)) }
    catch (error: any) {
      if (process.platform === 'win32' && error.code === 'EPERM') { context.skip(); return } // Linux CI exercises this assertion.
      throw error
    }
    await expect(readOwnedFile(alice.id, file.id)).rejects.toMatchObject({ status: 404 })
  })

  it('revokes deleted files and supports repeated owner deletion', async () => {
    const file = await ownedImage()
    expect((await fetch(`${base}/api/files/${file.id}`, { method: 'DELETE', headers: bearer(bob.id) })).status).toBe(404)
    await deleteOwnedFile(alice.id, file.id)
    await deleteOwnedFile(alice.id, file.id)
    await expect(readOwnedFile(alice.id, file.id)).rejects.toMatchObject({ status: 404 })
  })

  it('retires public uploads without looking up a filename', async () => {
    expect((await fetch(`${base}/uploads/artifacts/old.html`)).status).toBe(410)
  })

  it.each([true, false])('handles SDK configuration rejection before v1 headers with stream=%s', async stream => {
    const key = await createApiKey(alice.id, 'SDK rejection fixture')
    await db.user.update({ where: { id: alice.id }, data: { apiBalanceMicros: 1_000_000n } })
    vi.mocked(createClient).mockImplementationOnce(() => { throw new Error('fixture-secret in invalid configuration') })
    const res = await fetch(`${base}/v1/chat/completions`, { method: 'POST',
      headers: { Authorization: `Bearer ${key.key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'loop-chat', messages: [{ role: 'user', content: 'q' }], stream }) })
    expect(res.status).toBe(502)
    const body = await res.json()
    expect(body.error.message).toBe('Upstream model request failed.')
    expect(JSON.stringify(body)).not.toContain('fixture-secret')
  })

  it.each([true, false])('cancels v1 inference on HTTP disconnect with stream=%s', async stream => {
    const key = await createApiKey(alice.id, 'SDK cancellation fixture')
    await db.user.update({ where: { id: alice.id }, data: { apiBalanceMicros: 1_000_000n } })
    let markStarted!: () => void, markCancelled!: () => void
    const started = new Promise<void>(resolve => { markStarted = resolve })
    const cancelled = new Promise<void>(resolve => { markCancelled = resolve })
    model.vision.mockImplementationOnce(async (...args: any[]) => {
      const signal = args[1].signal as AbortSignal
      markStarted()
      return new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => {
        markCancelled(); reject(new Error('cancelled fixture'))
      }, { once: true }))
    })
    const abort = new AbortController()
    try {
      const pending = fetch(`${base}/v1/chat/completions`, { method: 'POST', signal: abort.signal,
        headers: { Authorization: `Bearer ${key.key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'q' }], stream }) }).catch(() => undefined)
      await started; abort.abort(); await cancelled; await pending
      await expect.poll(async () => (await db.apiReservation.findFirst({ where: { apiKeyId: key.id } }))?.state).toBe('unknown')
      const hold = await db.apiReservation.findFirstOrThrow({ where: { apiKeyId: key.id } })
      expect((await db.user.findUniqueOrThrow({ where: { id: alice.id } })).apiBalanceMicros).toBe(1_000_000n - hold.amountMicros)
      expect(await db.apiUsage.count({ where: { reservationId: hold.id } })).toBe(0)
    } finally { abort.abort() }
  })
})
