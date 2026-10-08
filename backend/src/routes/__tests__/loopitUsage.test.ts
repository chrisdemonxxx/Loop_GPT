import type { Server } from 'node:http'
import express from 'express'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mintLoopitIdentityToken } from '../../services/loopitIdentity'

const config = {
  secret: 'usage-test-identity-secret-at-least-32b',
  kid: 'usage-kid',
  issuer: 'loopit-gateway',
  audience: 'loopit-control-plane',
}

const usage = vi.hoisted(() => ({
  recordLoopitUsage: vi.fn(),
}))

vi.mock('../../services/prisma', () => ({
  get prisma() { return {} },
  get hasDb() { return true },
}))

vi.mock('../../services/loopitUsage', async () => {
  const actual = await vi.importActual<typeof import('../../services/loopitUsage')>('../../services/loopitUsage')
  return { ...actual, recordLoopitUsage: usage.recordLoopitUsage }
})

import loopitRoutes from '../loopit'

let server: Server
let base: string

beforeAll(async () => {
  process.env.LOOPIT_IDENTITY_SECRET = config.secret
  process.env.LOOPIT_IDENTITY_KID = config.kid
  delete process.env.LOOPIT_IDENTITY_ISSUER
  delete process.env.LOOPIT_IDENTITY_AUDIENCE
  const app = express()
  app.use(express.json())
  app.use('/api/loopit', loopitRoutes)
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve) })
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})
afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())) })
beforeEach(() => { usage.recordLoopitUsage.mockReset() })

function token(org: string): string {
  return mintLoopitIdentityToken({
    subject: 'user-1', orgId: org, role: 'member', now: Math.floor(Date.now() / 1000), config,
  })
}

function post(org: string, body: unknown, bearer = token(org)) {
  return fetch(`${base}/api/loopit/usage`, {
    method: 'POST',
    headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

const event = {
  idempotencyKey: 'run-1-sandbox',
  kind: 'sandbox_seconds',
  sandboxSeconds: 120,
  runId: 'run-1',
}

describe('POST /api/loopit/usage', () => {
  it('bills the token workspace and rejects another tenant id', async () => {
    usage.recordLoopitUsage.mockImplementation(async (workspaceId: string) => ({
      reservationId: `res-${workspaceId}`,
      credits: 2,
      duplicate: false,
      ownerId: workspaceId === 'ws-a' ? 'owner-a' : 'owner-b',
    }))

    const billed = await post('ws-a', { ...event, tenantId: 'ws-a' })
    expect(billed.status).toBe(200)
    expect(await billed.json()).toMatchObject({ workspaceId: 'ws-a', ownerId: 'owner-a', credits: 2, duplicate: false })
    expect(usage.recordLoopitUsage).toHaveBeenCalledWith('ws-a', expect.objectContaining({
      idempotencyKey: 'run-1-sandbox', kind: 'sandbox_seconds', sandboxSeconds: 120,
    }))

    usage.recordLoopitUsage.mockClear()
    const crossed = await post('ws-a', { ...event, tenantId: 'ws-b' })
    expect(crossed.status).toBe(403)
    expect(usage.recordLoopitUsage).not.toHaveBeenCalled()

    const other = await post('ws-b', event)
    expect(other.status).toBe(200)
    expect(await other.json()).toMatchObject({ workspaceId: 'ws-b', ownerId: 'owner-b' })
    expect(usage.recordLoopitUsage).toHaveBeenCalledWith('ws-b', expect.objectContaining({ idempotencyKey: 'run-1-sandbox' }))
  })

  it('rejects a workspace id field, a bad signature, and a second charge is the ledger duplicate flag', async () => {
    expect((await post('ws-a', { ...event, workspaceId: 'ws-b' })).status).toBe(400)
    const [header, payload] = token('ws-a').split('.')
    expect((await post('ws-a', event, `${header}.${payload}.nope`)).status).toBe(401)
    expect(usage.recordLoopitUsage).not.toHaveBeenCalled()

    usage.recordLoopitUsage
      .mockResolvedValueOnce({ reservationId: 'res-1', credits: 2, duplicate: false, ownerId: 'owner-a' })
      .mockResolvedValueOnce({ reservationId: 'res-1', credits: 2, duplicate: true, ownerId: 'owner-a' })
    expect((await post('ws-a', event)).status).toBe(200)
    const replay = await post('ws-a', event)
    expect(replay.status).toBe(200)
    expect(await replay.json()).toMatchObject({ duplicate: true, reservationId: 'res-1', credits: 2 })
    expect(usage.recordLoopitUsage).toHaveBeenCalledTimes(2)
  })
})
