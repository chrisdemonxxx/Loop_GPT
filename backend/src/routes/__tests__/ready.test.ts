import { describe, expect, it, vi } from 'vitest'

vi.mock('../../services/prisma', () => ({ prisma: null, hasDb: false }))
vi.mock('../../services/privateStorage', () => ({ checkPrivateStorageReadiness: vi.fn(async () => {}) }))

import { readinessHandler } from '../ready'

async function run(deps: Parameters<typeof readinessHandler>[0]) {
  const out: any = { headers: {} }
  const res: any = {
    setHeader: (k: string, v: string) => { out.headers[k] = v },
    status: (code: number) => { out.status = code; return res },
    json: (body: unknown) => { out.body = body; return res },
  }
  await readinessHandler(deps)({} as any, res)
  return out
}

describe('GET /ready', () => {
  it('is ready when the database and storage answer', async () => {
    const out = await run({ database: async () => 1, storage: async () => {} })
    expect(out.status).toBe(200)
    expect(out.body).toEqual({ status: 'ready', checks: { database: 'ok', storage: 'ok' } })
    expect(out.headers['Cache-Control']).toBe('no-store')
  })
  it('reports which dependency failed without its error text', async () => {
    const out = await run({ database: async () => { throw new Error('password authentication failed for user x') }, storage: async () => {} })
    expect(out.status).toBe(503)
    expect(out.body.checks).toEqual({ database: 'fail', storage: 'ok' })
    expect(JSON.stringify(out.body)).not.toContain('password')
  })
  it('treats a hung dependency as not ready', async () => {
    const out = await run({ database: async () => 1, storage: () => new Promise(() => {}), timeoutMs: 20 })
    expect(out.status).toBe(503)
    expect(out.body.checks.storage).toBe('fail')
  })
  it('is not ready without a configured database', async () => {
    const out = await run(undefined)
    expect(out.status).toBe(503)
    expect(out.body.checks.database).toBe('fail')
  })
})
