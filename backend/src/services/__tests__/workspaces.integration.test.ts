import { randomUUID } from 'crypto'
import type { Server } from 'http'
import express from 'express'
import jwt from 'jsonwebtoken'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import router from '../../routes/workspaces'
import { prisma } from '../prisma'
import { changeMembership, createWorkspace, ensurePersonalWorkspace, requireMembership } from '../workspaces'
import { loadConnectionForExecution, saveConnection } from '../workspaceConnections'

const db = prisma!
const prefix = `workspaces-${randomUUID()}`
const workspaceIds = new Set<string>()
let sequence = 0
let server: Server
let base: string
let previousKey: string | undefined
let alice: string, bob: string, editor: string, viewer: string
let personal: string, foreign: string
const secret = 'fixture-not-a-real-provider-secret'
const input = (token = secret) => ({ type: 'notion', name: 'Notes', enabled: true, config: { token } })

async function user(label: string) {
  const id = `${prefix}-${label}-${++sequence}`
  await db.user.create({ data: { id, email: `${id}@example.test`, name: label, password: 'fixture-only' } })
  return id
}
async function team() {
  const workspace = await createWorkspace(alice, 'Team fixture')
  workspaceIds.add(workspace.id)
  await db.workspaceMember.createMany({ data: [
    { workspaceId: workspace.id, userId: editor, role: 'editor' },
    { workspaceId: workspace.id, userId: viewer, role: 'viewer' },
  ] })
  return workspace.id
}
async function request(path: string, userId?: string, method = 'GET', body?: unknown) {
  return fetch(`${base}${path}`, { method, headers: {
    ...(userId ? { Authorization: `Bearer ${jwt.sign({ userId }, process.env.JWT_SECRET!)}` } : {}),
    ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
  }, body: body === undefined ? undefined : JSON.stringify(body) })
}
async function createConnection(workspaceId = personal) {
  return saveConnection(alice, workspaceId, input())
}

beforeAll(async () => {
  previousKey = process.env.CONNECTION_ENCRYPTION_KEY
  process.env.CONNECTION_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64')
  alice = await user('alice'); bob = await user('bob'); editor = await user('editor'); viewer = await user('viewer')
  personal = (await ensurePersonalWorkspace(alice)).id
  foreign = (await ensurePersonalWorkspace(bob)).id
  // Platform administrators are not implicitly workspace members.
  await db.user.update({ where: { id: bob }, data: { role: 'admin' } })
  const app = express()
  app.use('/api/workspaces', router)
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing test port')
  base = `http://127.0.0.1:${address.port}/api/workspaces`
})

afterAll(async () => {
  try {
    if (server) await new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close((error) => error ? reject(error) : resolve()) })
    await db.workspace.deleteMany({ where: { id: { in: [...workspaceIds] } } })
    await db.user.deleteMany({ where: { id: { startsWith: prefix } } })
  } finally {
    if (previousKey === undefined) delete process.env.CONNECTION_ENCRYPTION_KEY
    else process.env.CONNECTION_ENCRYPTION_KEY = previousKey
    await db.$disconnect()
  }
})

describe('workspace HTTP and PostgreSQL boundaries', () => {
  it('requires authentication on workspace routes', async () => {
    expect((await request('/')).status).toBe(401)
    expect((await request('/personal', undefined, 'POST', {})).status).toBe(401)
    expect((await request(`/${personal}/connections`)).status).toBe(401)
  })

  it('provisions exactly one personal workspace under concurrency', async () => {
    const owner = await user('concurrent')
    const responses = await Promise.all(Array.from({ length: 8 }, () => request('/personal', owner, 'POST', {})))
    expect(responses.map((r) => r.status)).toEqual(Array(8).fill(200))
    const rows = await Promise.all(responses.map(async (r) => (await r.json() as any).workspace))
    expect(new Set(rows.map((row) => row.id)).size).toBe(1)
    expect(await db.workspaceMember.count({ where: { workspaceId: rows[0].id, role: 'owner' } })).toBe(1)
    expect(await db.workspaceAuditEvent.count({ where: { workspaceId: rows[0].id, action: 'workspace.created' } })).toBe(1)
    expect((await request('/personal', `${prefix}-missing`, 'POST', {})).status).toBe(401)
  })

  it('creates an owned workspace and rejects injected ownership fields', async () => {
    expect((await request('/', alice, 'POST', { name: 'Team', personalOwnerId: bob })).status).toBe(400)
    const response = await request('/', alice, 'POST', { name: '  Customer team  ' })
    expect(response.status).toBe(201)
    const { workspace } = await response.json() as any
    workspaceIds.add(workspace.id)
    expect(workspace.name).toBe('Customer team')
    expect((await requireMembership(alice, workspace.id)).role).toBe('owner')
    await expect(requireMembership(bob, workspace.id)).rejects.toMatchObject({ status: 404 })
  })

  it('lists only the authenticated account memberships', async () => {
    const response = await request('/', alice)
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    const { workspaces } = await response.json() as any
    expect(workspaces.some((w: any) => w.id === personal)).toBe(true)
    expect(workspaces.some((w: any) => w.id === foreign)).toBe(false)
  })

  it('hides foreign workspaces, even from platform administrators', async () => {
    for (const path of ['connections', 'connections/catalog', 'members', 'audit']) {
      expect((await request(`/${personal}/${path}`, bob)).status).toBe(404)
    }
    expect((await request(`/${personal}/connections`, bob, 'POST', input())).status).toBe(404)
  })

  it('stores only encrypted credentials, with redacted management responses and audit', async () => {
    const response = await request(`/${personal}/connections`, alice, 'POST', input())
    expect(response.status).toBe(201)
    const text = await response.text()
    expect(text).not.toContain(secret)
    expect(text).not.toContain('encryptedConfig')
    const { connection } = JSON.parse(text)
    const stored = await db.workspaceConnection.findUniqueOrThrow({ where: { id: connection.id } })
    expect(stored.encryptedConfig).not.toContain(secret)
    expect(connection.configuredFields).toEqual(['token'])
    const listing = await (await request(`/${personal}/connections`, alice)).text()
    expect(listing).not.toContain(secret)
    expect(listing).not.toContain('encryptedConfig')
    const audit = await (await request(`/${personal}/audit`, alice)).text()
    expect(audit).toContain('connection.created')
    expect(audit).not.toContain(secret)
    expect((await loadConnectionForExecution(alice, personal, connection.id, 1)).config.token).toBe(secret)
  })

  it('does not accept unsupported, unknown, or incomplete configurations', async () => {
    for (const body of [input(''), { ...input(), type: 'jira' }, { ...input(), type: 'unknown' },
      { ...input(), config: { token: secret, baseUrl: 'http://localhost' } }, { ...input(), workspaceId: foreign }]) {
      expect([400, 422]).toContain((await request(`/${personal}/connections`, alice, 'POST', body)).status)
    }
    const catalog = await (await request(`/${personal}/connections/catalog`, alice)).json() as any
    expect(catalog.connectors.filter((entry: any) => entry.executionEnabled).map((entry: any) => entry.type).sort()).toEqual(['gitlab', 'notion'])
    expect(catalog.connectors.find((entry: any) => entry.type === 'notion').configurationSupported).toBe(true)
  })

  it('fails closed without a key and never stores plaintext as fallback', async () => {
    const key = process.env.CONNECTION_ENCRYPTION_KEY
    const count = await db.workspaceConnection.count({ where: { workspaceId: personal } })
    delete process.env.CONNECTION_ENCRYPTION_KEY
    try {
      expect((await request(`/${personal}/connections`, alice, 'POST', input())).status).toBe(503)
      expect(await db.workspaceConnection.count({ where: { workspaceId: personal } })).toBe(count)
    } finally { process.env.CONNECTION_ENCRYPTION_KEY = key }
  })

  it('bounds JSON bodies and does not reflect malformed credential input', async () => {
    expect((await request(`/${personal}/connections`, alice, 'POST', input('a'.repeat(70000)))).status).toBe(413)
    const response = await fetch(`${base}/${personal}/connections`, { method: 'POST', headers: {
      Authorization: `Bearer ${jwt.sign({ userId: alice }, process.env.JWT_SECRET!)}`, 'Content-Type': 'application/json',
    }, body: `{"token":"${secret}"` })
    expect(response.status).toBe(400)
    expect(await response.text()).not.toContain(secret)
  })

  it('limits editor and viewer roles and prevents owner changes', async () => {
    const workspaceId = await team()
    const connection = await createConnection(workspaceId)
    expect((await request(`/${workspaceId}/connections`, viewer)).status).toBe(200)
    for (const member of [editor, viewer]) {
      expect((await request(`/${workspaceId}/connections`, member, 'POST', input())).status).toBe(403)
      expect((await request(`/${workspaceId}/connections/${connection.id}`, member, 'DELETE')).status).toBe(403)
      expect((await request(`/${workspaceId}/audit`, member)).status).toBe(403)
      expect((await request(`/${workspaceId}/members/${viewer}`, member, 'DELETE')).status).toBe(403)
    }
    expect((await loadConnectionForExecution(editor, workspaceId, connection.id, 1)).config).toEqual(input().config)
    await expect(loadConnectionForExecution(viewer, workspaceId, connection.id, 1)).rejects.toMatchObject({ status: 403 })
    expect((await request(`/${workspaceId}/members/${alice}`, alice, 'DELETE')).status).toBe(409)
    expect((await request(`/${workspaceId}/members/${viewer}`, alice, 'PATCH', { role: 'owner' })).status).toBe(400)
    expect((await request(`/${workspaceId}/members/${alice}`, alice, 'PATCH', { role: 'viewer' })).status).toBe(409)
  })

  it('requires a positive version for service and HTTP updates', async () => {
    const connection = await createConnection()
    for (const expectedVersion of [undefined, 0, -1, 1.5, '1']) {
      expect((await request(`/${personal}/connections/${connection.id}`, alice, 'PUT', { ...input(), expectedVersion })).status).toBe(400)
    }
    await expect(saveConnection(alice, personal, input(), connection.id)).rejects.toThrow()
    await expect(loadConnectionForExecution(alice, personal, connection.id, undefined as any)).rejects.toThrow()
    expect((await db.workspaceConnection.findUniqueOrThrow({ where: { id: connection.id } })).version).toBe(1)
    await db.workspaceConnection.update({ where: { id: connection.id }, data: { version: 2147483647 } })
    expect((await loadConnectionForExecution(alice, personal, connection.id, 2147483647)).config.token).toBe(secret)
  })

  it('does not change or decrypt a foreign connection using an owned workspace ID', async () => {
    const connection = await saveConnection(bob, foreign, input())
    expect((await request(`/${personal}/connections/${connection.id}`, alice, 'PUT', { ...input(), expectedVersion: 1 })).status).toBe(409)
    expect((await request(`/${personal}/connections/${connection.id}`, alice, 'DELETE')).status).toBe(404)
    await expect(loadConnectionForExecution(alice, personal, connection.id, 1)).rejects.toMatchObject({ status: 403 })
    expect((await db.workspaceConnection.findUniqueOrThrow({ where: { id: connection.id } })).version).toBe(1)
  })

  it('permits one winner for concurrent credential replacements and audits only committed changes', async () => {
    const connection = await createConnection()
    const responses = await Promise.all(['rotation-a', 'rotation-b'].map((token) => request(`/${personal}/connections/${connection.id}`, alice, 'PUT', { ...input(token), expectedVersion: 1 })))
    expect(responses.map((r) => r.status).sort()).toEqual([200, 409])
    expect((await db.workspaceConnection.findUniqueOrThrow({ where: { id: connection.id } })).version).toBe(2)
    expect(await db.workspaceAuditEvent.count({ where: { resourceId: connection.id, action: 'connection.updated' } })).toBe(1)
    await expect(loadConnectionForExecution(alice, personal, connection.id, 1)).rejects.toMatchObject({ status: 403 })
    expect(['rotation-a', 'rotation-b']).toContain((await loadConnectionForExecution(alice, personal, connection.id, 2)).config.token)
  })

  it('blocks subsequent credential loads after disabling or deleting a connection', async () => {
    const connection = await createConnection()
    const disabled = await request(`/${personal}/connections/${connection.id}`, alice, 'PUT', { ...input(), enabled: false, expectedVersion: 1 })
    expect(disabled.status).toBe(200)
    await expect(loadConnectionForExecution(alice, personal, connection.id, 2)).rejects.toMatchObject({ status: 403 })
    expect((await request(`/${personal}/connections/${connection.id}`, alice, 'DELETE')).status).toBe(204)
    expect((await request(`/${personal}/connections/${connection.id}`, alice, 'DELETE')).status).toBe(404)
    await expect(loadConnectionForExecution(alice, personal, connection.id, 2)).rejects.toMatchObject({ status: 403 })
  })

  it('rechecks membership after a downgrade or removal', async () => {
    const workspaceId = await team()
    const connection = await createConnection(workspaceId)
    expect((await loadConnectionForExecution(editor, workspaceId, connection.id, 1)).config.token).toBe(secret)
    expect((await request(`/${workspaceId}/members/${editor}`, alice, 'PATCH', { role: 'viewer' })).status).toBe(204)
    await expect(loadConnectionForExecution(editor, workspaceId, connection.id, 1)).rejects.toMatchObject({ status: 403 })
    await changeMembership(alice, workspaceId, editor, 'editor')
    expect((await request(`/${workspaceId}/members/${editor}`, alice, 'DELETE')).status).toBe(204)
    await expect(loadConnectionForExecution(editor, workspaceId, connection.id, 1)).rejects.toMatchObject({ status: 404 })
    expect((await request(`/${workspaceId}/connections`, editor)).status).toBe(404)
  })

  it('rejects ciphertext copied between connections', async () => {
    const a = await createConnection(); const b = await createConnection()
    const ciphertext = (await db.workspaceConnection.findUniqueOrThrow({ where: { id: a.id } })).encryptedConfig
    await db.workspaceConnection.update({ where: { id: b.id }, data: { encryptedConfig: ciphertext } })
    await expect(loadConnectionForExecution(alice, personal, b.id, 1)).rejects.toMatchObject({ status: 503 })
  })

  it('paginates metadata without returning ciphertext or repeating rows', async () => {
    const workspaceId = await team()
    await db.workspaceConnection.createMany({ data: Array.from({ length: 101 }, () => ({
      id: randomUUID(), workspaceId, type: 'notion', name: 'Pagination fixture', configuredFields: ['token'], encryptedConfig: 'non-executable-test-fixture',
    })) })
    const first = await (await request(`/${workspaceId}/connections`, alice)).json() as any
    const second = await (await request(`/${workspaceId}/connections?after=${first.nextCursor}`, alice)).json() as any
    expect(first.connections).toHaveLength(100)
    expect(second.connections).toHaveLength(1)
    expect(second.nextCursor).toBeNull()
    expect(new Set([...first.connections, ...second.connections].map((row: any) => row.id)).size).toBe(101)
    expect(JSON.stringify(first)).not.toContain('non-executable-test-fixture')
  })
})
