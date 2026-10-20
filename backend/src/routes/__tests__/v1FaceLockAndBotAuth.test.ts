import { afterEach, describe, expect, it, vi } from 'vitest'
import express from 'express'

vi.mock('../../services/apiKeys', () => ({
  looksLikeApiKey: (v: string) => typeof v === 'string' && v.trim().startsWith('sk-loop-'),
  resolveApiKey: vi.fn(async (raw: string) => {
    if (raw === 'sk-loop-validkey000000000000000000000000000000000000') {
      return {
        apiKeyId: 'key-1',
        userId: 'user-from-apikey',
        plan: 'developer',
        balanceMicros: 5_000_000n,
        unlimited: false,
      }
    }
    return null
  }),
}))

import v1Routes from '../v1'
import { authenticateTokenOrApiKey } from '../../middleware/apiAuth'
import { BOT_VM_MINUTES_PER_DAY } from '../../services/agentTasks'

const VALID_KEY = 'sk-loop-validkey000000000000000000000000000000000000'
const savedEdition = process.env.LOOP_EDITION

afterEach(() => {
  if (savedEdition === undefined) delete process.env.LOOP_EDITION
  else process.env.LOOP_EDITION = savedEdition
})

async function postV1Images(body: Record<string, unknown>, apiKey = VALID_KEY) {
  const app = express()
  app.use('/v1', v1Routes)
  const server = await new Promise<import('http').Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s))
  })
  try {
    const addr = server.address() as import('net').AddressInfo
    const res = await fetch(`http://127.0.0.1:${addr.port}/v1/images/generations`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    })
    return { status: res.status, json: await res.json() }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

describe('POST /v1/images/generations face_lock & consent gate', () => {
  it('rejects face_lock=true when image_prompt is missing', async () => {
    process.env.LOOP_EDITION = 'adult'
    const { status, json } = await postV1Images({
      prompt: 'a portrait in oil paint',
      face_lock: true,
      consent_attestation: true,
    })
    expect(status).toBe(400)
    expect(json.error?.code).toBe('missing_reference_image')
  })

  it('rejects face_lock=true in mainstream edition when consent_attestation is not true', async () => {
    process.env.LOOP_EDITION = 'mainstream'
    const { status, json } = await postV1Images({
      prompt: 'a portrait in oil paint',
      image_prompt: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      face_lock: true,
    })
    expect(status).toBe(400)
    expect(json.error?.code).toBe('consent_required')
  })

  it('allows face_lock=true in the adult edition without blocking on consent_required', async () => {
    process.env.LOOP_EDITION = 'adult'
    const { status, json } = await postV1Images({
      prompt: 'a portrait in oil paint',
      image_prompt: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      face_lock: true,
    })
    // Passes validation and reaches billing/endpoint stage (503 in test env)
    expect(status).toBe(503)
    expect(['not_configured', 'accounting_unavailable', 'unavailable']).toContain(json.error?.code)
  })
})

describe('authenticateTokenOrApiKey dual auth middleware', () => {
  it('authenticates sk-loop-* API keys and populates req.userId', async () => {
    const app = express()
    app.get('/probe', authenticateTokenOrApiKey, (req, res) => {
      res.json({ userId: (req as any).userId, apiKeyId: (req as any).api?.apiKeyId })
    })
    const server = await new Promise<import('http').Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s))
    })
    try {
      const addr = server.address() as import('net').AddressInfo
      const res = await fetch(`http://127.0.0.1:${addr.port}/probe`, {
        headers: { Authorization: `Bearer ${VALID_KEY}` },
      })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ userId: 'user-from-apikey', apiKeyId: 'key-1' })
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('rejects revoked/invalid sk-loop-* API keys with 401', async () => {
    const app = express()
    app.get('/probe', authenticateTokenOrApiKey, (req, res) => {
      res.json({ userId: (req as any).userId })
    })
    const server = await new Promise<import('http').Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s))
    })
    try {
      const addr = server.address() as import('net').AddressInfo
      const res = await fetch(`http://127.0.0.1:${addr.port}/probe`, {
        headers: { Authorization: 'Bearer sk-loop-badkey00000000000000000000000000000000000000' },
      })
      expect(res.status).toBe(401)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})

describe('BOT_VM_MINUTES_PER_DAY max plan', () => {
  it('grants max plan 120 daily bot VM minutes (> pro)', () => {
    expect(BOT_VM_MINUTES_PER_DAY.max).toBe(120)
    expect(BOT_VM_MINUTES_PER_DAY.max).toBeGreaterThan(BOT_VM_MINUTES_PER_DAY.pro)
  })
})
