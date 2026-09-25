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
import { shareRouter } from '../../routes/share'
import messagesRouter from '../../routes/messages'
import agentRouter from '../../routes/agent'
import v1Router from '../../routes/v1'
import { filesRouter, publicFilesRouter, imageUploadRouter, rejectLegacyUploads } from '../../routes/files'
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
  // Same mount order as server.ts: the public token route must be reached
// before filesRouter, whose router-wide auth use() would otherwise swallow
// the anonymous public path.
app.use('/api/files', publicFilesRouter)
app.use('/api/files', filesRouter)
  app.use('/api/conversations', imageUploadRouter, conversationsRouter, messagesRouter, agentRouter)
app.use('/api/share', shareRouter) // unauthenticated; token-gated transcript reads
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

  it('pins conversations to the top without bumping recency (audit §8-13)', async () => {
    const older = await db.conversation.create({ data: { userId: alice.id, title: 'Pinned target' } })
    const newer = await db.conversation.create({ data: { userId: alice.id, title: 'Fresh chat' } })
    const before = (await (await fetch(`${base}/api/conversations`, { headers: bearer(alice.id) })).json()) as any[]
    // Pin the OLDER one: it must float to the top ahead of the newer chat.
    expect((await fetch(`${base}/api/conversations/${older.id}`, { method: 'PATCH', headers: { ...bearer(alice.id), 'Content-Type': 'application/json' }, body: JSON.stringify({ pinned: true }) })).status).toBe(200)
    const after = (await (await fetch(`${base}/api/conversations`, { headers: bearer(alice.id) })).json()) as any[]
    expect(after.find((c) => c.id === older.id).pinned).toBe(true)
    expect(after.find((c) => c.id === newer.id).pinned).toBe(false)
    expect(after[0].id).toBe(older.id)
    // Pinning must not rewrite updatedAt (date groups stay stable).
    expect(new Date(after.find((c) => c.id === older.id).updatedAt).getTime())
      .toBe(new Date(before.find((c) => c.id === older.id).updatedAt).getTime())
    // Ownership: another user cannot pin or read.
    expect((await fetch(`${base}/api/conversations/${older.id}`, { method: 'PATCH', headers: { ...bearer(bob.id), 'Content-Type': 'application/json' }, body: JSON.stringify({ pinned: true }) })).status).toBe(404)
  })

  it('creates, reads, and revokes public read-only share links (audit §8-15)', async () => {
    const shared = await db.conversation.create({ data: { userId: alice.id, title: 'Share me' } })
    await db.message.create({ data: { conversationId: shared.id, role: 'user', content: 'Shared question' } })
    await db.message.create({ data: { conversationId: shared.id, role: 'assistant', content: 'Shared answer' } })
    // Only the owner can mint; the token is idempotent.
    expect((await fetch(`${base}/api/conversations/${shared.id}/share`, { method: 'POST', headers: bearer(bob.id) })).status).toBe(404)
    const mint = await (await fetch(`${base}/api/conversations/${shared.id}/share`, { method: 'POST', headers: bearer(alice.id) })).json()
    const remint = await (await fetch(`${base}/api/conversations/${shared.id}/share`, { method: 'POST', headers: bearer(alice.id) })).json()
    expect(mint.token).toBe(remint.token)
    // Anonymous transcript read: roles/content only, never user ids or file paths.
    const publicRead = await fetch(`${base}/api/share/${mint.token}`)
    expect(publicRead.status).toBe(200)
    const body = await publicRead.json()
    expect(body.title).toBe('Share me')
    expect(body.messages).toEqual([
      expect.objectContaining({ role: 'user', content: 'Shared question' }),
      expect.objectContaining({ role: 'assistant', content: 'Shared answer' }),
    ])
    expect(JSON.stringify(body)).not.toContain(alice.id)
    // Malformed tokens never leak whether a share exists.
    expect((await fetch(`${base}/api/share/${'0'.repeat(32)}`)).status).toBe(404)
    // Revoking kills the public read; the owner can mint a new token later.
    expect((await fetch(`${base}/api/conversations/${shared.id}/share`, { method: 'DELETE', headers: bearer(alice.id) })).status).toBe(200)
    expect((await fetch(`${base}/api/share/${mint.token}`)).status).toBe(404)
  })

  it('searches message bodies, not just titles (audit §8-16)', async () => {
    const searchable = await db.conversation.create({ data: { userId: alice.id, title: 'Boring title' } })
    await db.message.create({ data: { conversationId: searchable.id, role: 'assistant', content: 'The zebra runs at midnight across the plain.' } })
    const incognito = await db.conversation.create({ data: { userId: alice.id, title: 'Hidden', incognito: true } })
    await db.message.create({ data: { conversationId: incognito.id, role: 'assistant', content: 'zebra in a private den' } })
    const hits = (await (await fetch(`${base}/api/conversations/search?q=zebra`, { headers: bearer(alice.id) })).json()) as any[]
    expect(hits).toHaveLength(1)
    expect(hits[0].conversationId).toBe(searchable.id)
    expect(hits[0].snippet).toContain('zebra')
    // Ownership: bob sees no hits in alice's messages.
    expect(((await (await fetch(`${base}/api/conversations/search?q=zebra`, { headers: bearer(bob.id) })).json()) as any[]).length).toBe(0)
    // Short queries are a no-op, and the route is not shadowed by /:id.
    expect(((await (await fetch(`${base}/api/conversations/search?q=z`, { headers: bearer(alice.id) })).json()) as any[]).length).toBe(0)
  })

  it('mints short-lived signed links that render inline without a session (open in new tab)', async () => {
    const file = await ownedImage()
    // Only the owner may mint; a foreign session gets the ownership 404.
    expect((await fetch(`${base}/api/files/${file.id}/signed-link`, { method: 'POST', headers: bearer(bob.id) })).status).toBe(404)
    const mint = await fetch(`${base}/api/files/${file.id}/signed-link`, { method: 'POST', headers: bearer(alice.id) })
    expect(mint.status).toBe(200)
    const { url, expiresIn } = await mint.json()
    expect(url).toContain(`/api/files/${file.id}/content?p=`)
    expect(expiresIn).toBeGreaterThan(0)
    // The new tab has no Authorization header — the signature is the credential.
    const open = await fetch(`${base}${url}`)
    expect(open.status).toBe(200)
    expect(open.headers.get('content-disposition')).toContain('inline;')
    expect(open.headers.get('content-security-policy')).toContain('sandbox')
    expect(Buffer.from(await open.arrayBuffer())).toEqual(png)
    // The in-app (header-auth) path still downloads rather than renders.
    const attached = await fetch(`${base}/api/files/${file.id}/content`, { headers: bearer(alice.id) })
    expect(attached.headers.get('content-disposition')).toContain('attachment;')
  })

  it('rejects tampered and cross-file signed links without a session', async () => {
    const file = await ownedImage()
    const other = await storePrivateFile({ userId: alice.id, conversationId: conversation.id, name: 'other.png', mimeType: 'image/png', purpose: 'artifact', buffer: png })
    const mint = await fetch(`${base}/api/files/${file.id}/signed-link`, { method: 'POST', headers: bearer(alice.id) })
    const { url } = await mint.json()
    // Tampered signature falls back to header auth → 401 (no session).
    expect((await fetch(`${base}${url.replace(/([?&]s=.{4}).*/, '$1AAAAAAA')}`)).status).toBe(401)
    // A link minted for one file cannot be replayed against another file id.
    const crossFile = url.replace(`/api/files/${file.id}/content`, `/api/files/${other.id}/content`)
    expect((await fetch(`${base}${crossFile}`)).status).toBe(401)
    // Query-string garbage never bypasses the auth guard.
    expect((await fetch(`${base}/api/files/${other.id}/content?p=AAAA&s=BBBB`)).status).toBe(401)
  })

  it('serves byte ranges: Accept-Ranges on the first response, 206 + Content-Range for Range requests (audit P3)', async () => {
    const file = await ownedImage()
    // The FIRST response advertises byte-range support and carries the full body.
    const first = await fetch(`${base}/api/files/${file.id}/content`, { headers: bearer(alice.id) })
    expect(first.status).toBe(200)
    expect(first.headers.get('accept-ranges')).toBe('bytes')
    expect(Number(first.headers.get('content-length'))).toBe(png.length)
    expect(Buffer.from(await first.arrayBuffer())).toEqual(png)

    // A bounded range returns exactly the requested slice as 206.
    const part = await fetch(`${base}/api/files/${file.id}/content`, { headers: { ...bearer(alice.id), Range: 'bytes=0-9' } })
    expect(part.status).toBe(206)
    expect(part.headers.get('content-range')).toBe(`bytes 0-9/${png.length}`)
    expect(part.headers.get('accept-ranges')).toBe('bytes')
    expect(Number(part.headers.get('content-length'))).toBe(10)
    expect(Buffer.from(await part.arrayBuffer())).toEqual(png.subarray(0, 10))

    // Open-ended and suffix forms work as the video element issues them.
    const tail = await fetch(`${base}/api/files/${file.id}/content`, { headers: { ...bearer(alice.id), Range: 'bytes=-10' } })
    expect(tail.status).toBe(206)
    expect(Buffer.from(await tail.arrayBuffer())).toEqual(png.subarray(png.length - 10))
    const rest = await fetch(`${base}/api/files/${file.id}/content`, { headers: { ...bearer(alice.id), Range: `bytes=10-` } })
    expect(rest.status).toBe(206)
    expect(Buffer.from(await rest.arrayBuffer())).toEqual(png.subarray(10))

    // Unsatisfiable ranges get 416 with the total.
    const invalid = await fetch(`${base}/api/files/${file.id}/content`, { headers: { ...bearer(alice.id), Range: `bytes=${png.length + 10}-` } })
    expect(invalid.status).toBe(416)
    expect(invalid.headers.get('content-range')).toBe(`bytes */${png.length}`)
  })

  it('supports byte ranges over signed links and published tokens (streaming <video> paths)', async () => {
    const file = await ownedImage()
    const mint = await fetch(`${base}/api/files/${file.id}/signed-link`, { method: 'POST', headers: bearer(alice.id) })
    const { url } = await mint.json()
    // Signed link + Range (sessionless streaming).
    const signedPart = await fetch(`${base}${url}`, { headers: { Range: 'bytes=0-9' } })
    expect(signedPart.status).toBe(206)
    expect(signedPart.headers.get('content-range')).toBe(`bytes 0-9/${png.length}`)
    expect(signedPart.headers.get('content-disposition')).toContain('inline;')
    expect(Buffer.from(await signedPart.arrayBuffer())).toEqual(png.subarray(0, 10))

    // Published token + Range (public shared video).
    const publish = await fetch(`${base}/api/files/${file.id}/publish`, { method: 'POST', headers: bearer(alice.id) })
    const { url: publicUrl } = await publish.json()
    const publicPart = await fetch(`${base}${publicUrl}`, { headers: { Range: 'bytes=0-9' } })
    expect(publicPart.status).toBe(206)
    expect(Buffer.from(await publicPart.arrayBuffer())).toEqual(png.subarray(0, 10))
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
