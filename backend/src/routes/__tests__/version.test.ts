import { describe, it, expect } from 'vitest'
import { servedRevision, revisionKnown, versionRouter } from '../version'
import type { Server } from 'http'
import express from 'express'

/**
 * The served-revision instrument (P1 decider gate). Two properties matter:
 * a real deployment env must be reported verbatim, and an absent one must
 * report `unknown` rather than a plausible-looking default.
 */
describe('servedRevision', () => {
  it('prefers an explicit GIT_REVISION over the platform variables', () => {
    expect(servedRevision({ GIT_REVISION: 'abc1234', RAILWAY_GIT_COMMIT_SHA: 'def5678' })).toBe('abc1234')
  })

  it('falls back to the Railway commit SHA (the real deploy path)', () => {
    expect(servedRevision({ RAILWAY_GIT_COMMIT_SHA: '9f8e7d6' })).toBe('9f8e7d6')
  })

  it('treats blank / whitespace-only values as absent', () => {
    expect(servedRevision({ GIT_REVISION: '   ', RAILWAY_GIT_COMMIT_SHA: '' })).toBe('unknown')
  })

  it('reports unknown, never a guess, when nothing is set', () => {
    expect(servedRevision({})).toBe('unknown')
    expect(revisionKnown({})).toBe(false)
    expect(revisionKnown({ GIT_REVISION: 'abc' })).toBe(true)
  })
})

describe('GET /api/version', () => {
  let server: Server
  let base = ''

  it('answers 200 with no credentials and no-store', async () => {
    const app = express()
    app.use('/api', versionRouter)
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const addr = server.address()
        if (addr && typeof addr === 'object') base = `http://127.0.0.1:${addr.port}`
        resolve()
      })
    })
    try {
      const res = await fetch(`${base}/api/version`)
      expect(res.status).toBe(200)
      expect(res.headers.get('cache-control')).toBe('no-store')
      const body = await res.json()
      expect(body.service).toBe('loop-gpt-backend')
      expect(typeof body.revision).toBe('string')
      expect(typeof body.startedAt).toBe('string')
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
