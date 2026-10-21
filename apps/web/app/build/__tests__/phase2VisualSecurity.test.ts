import { describe, expect, it, vi } from 'vitest'
import { createLoopitClient } from '@loop/loopit-client'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('Phase 2.1 / 2.2 / 2.8 client seams', () => {
  it('applyVisualEdit posts to visual-edit', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/token')) {
        return json({ token: 'tok', expiresAt: new Date(Date.now() + 120_000).toISOString() })
      }
      expect(url).toContain('/projects/proj_1/visual-edit')
      expect(init?.method).toBe('POST')
      return json({ applied: true, mode: 'codemod', path: 'src/App.tsx', message: 'ok' })
    })
    const client = createLoopitClient({ fetchImpl })
    const result = await client.applyVisualEdit('proj_1', {
      kind: 'text',
      value: 'Hello',
      loc: 'src/App.tsx:2:1',
      text: 'Hi',
    })
    expect(result.applied).toBe(true)
    expect(result.mode).toBe('codemod')
  })

  it('startBrowserTest returns offline stub shape', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/token')) {
        return json({ token: 'tok', expiresAt: new Date(Date.now() + 120_000).toISOString() })
      }
      return json({
        test_id: 'bt_abc',
        project_id: 'proj_1',
        status: 'passed',
        mode: 'offline',
        steps: [{ n: 1, t: 0, kind: 'browser:nav', url: 'http://x' }],
        summary: 'ok',
      })
    })
    const client = createLoopitClient({ fetchImpl })
    const run = await client.startBrowserTest('proj_1', { force_offline: true })
    expect(run.test_id).toBe('bt_abc')
    expect(run.mode).toBe('offline')
  })

  it('runSecurityScan returns findings payload', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/token')) {
        return json({ token: 'tok', expiresAt: new Date(Date.now() + 120_000).toISOString() })
      }
      return json({
        scan_id: 'sec_1',
        passed: true,
        mode: 'offline',
        findings: [],
        summary: 'No security findings.',
      })
    })
    const client = createLoopitClient({ fetchImpl })
    const scan = await client.runSecurityScan('proj_1', { force_offline: true })
    expect(scan.passed).toBe(true)
    expect(scan.findings).toEqual([])
  })
})
