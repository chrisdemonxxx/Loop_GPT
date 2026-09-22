import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  GOOGLE_CONNECTOR_ADAPTERS,
} from '../../connectors/googleAdapters'
import { marketplaceConnectorTools, probeMarketplaceConnector } from '../../connectors/marketplaceAdapters'
import type { ToolContext } from '../../agent/types'

/** Connector adapter CI stubs (brief P2): the Google tool builders and the
 * marketplace api_request/probe run against a fixture fetch — no network,
 * no DB; regressions in URL/shape/auth are caught here. */

const fetchMock = vi.fn()
beforeEach(() => { vi.stubGlobal('fetch', fetchMock) })
afterEach(() => { vi.unstubAllGlobals(); fetchMock.mockReset() })

const ctx = { signal: undefined, emit: () => {} } as unknown as ToolContext
const cfg = (config: Record<string, string>) => ({ id: 'cx1', type: 'google_drive', name: 'Test', config, enabled: true })

function jsonResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, headers: { get: () => 'application/json' }, json: async () => body, text: async () => JSON.stringify(body), arrayBuffer: async () => new ArrayBuffer(0) }
}

describe('google drive adapter (stub)', () => {
  it('lists files with Bearer auth and summarizes results', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ files: [{ name: 'Report.pdf', mimeType: 'application/pdf', webViewLink: 'https://drive/x' }] }))
    const tools = GOOGLE_CONNECTOR_ADAPTERS.google_drive!(cfg({ access_token: 'tok', expires_at: String(Date.now() + 600_000) }))
    const res = await tools[0].handler({ query: 'report' }, ctx)
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('https://www.googleapis.com/drive/v3/files?q='),
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer tok' }) })
    )
    expect((res as any).isError).toBeFalsy()
    expect((res as any).content).toContain('Report.pdf')
  })

  it('reports provider errors as isError without throwing', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 403, headers: { get: () => 'text/plain' }, text: async () => 'forbidden' })
    const tools = GOOGLE_CONNECTOR_ADAPTERS.google_drive!(cfg({ access_token: 'bad', expires_at: String(Date.now() + 600_000) }))
    const res = await tools[0].handler({}, ctx)
    expect((res as any).isError).toBe(true)
    expect((res as any).content).toContain('403')
  })
})

describe('gmail adapter (stub)', () => {
  it('decodes base64url message bodies', async () => {
    const body = Buffer.from('Hello from the test').toString('base64url')
    fetchMock.mockResolvedValueOnce(jsonResponse({
      payload: { headers: [{ name: 'From', value: 'a@b.c' }, { name: 'Subject', value: 'Hi' }], body: { data: body } },
    }))
    const tools = GOOGLE_CONNECTOR_ADAPTERS.gmail!(cfg({ access_token: 'tok', expires_at: String(Date.now() + 600_000) }))
    const res = await tools[1].handler({ messageId: 'm1' }, ctx)
    expect((res as any).content).toContain('Hello from the test')
    expect((res as any).content).toContain('a@b.c')
  })

  it('sends raw base64url MIME on send', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: 'sent' }))
    const tools = GOOGLE_CONNECTOR_ADAPTERS.gmail!(cfg({ access_token: 'tok', expires_at: String(Date.now() + 600_000) }))
    const res = await tools[2].handler({ to: 'x@y.z', subject: 'S', body: 'B' }, ctx)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toContain('/messages/send')
    const payload = JSON.parse(init.body)
    expect(payload.raw).toBeTruthy()
    expect(Buffer.from(payload.raw, 'base64url').toString()).toContain('To: x@y.z')
    expect((res as any).content).toContain('sent')
  })
})

describe('marketplace adapter (stub)', () => {
  const mcfg = { id: 'mk1', type: 'figma', name: 'Figma', config: { access_token: 'fig-tok' }, enabled: true }
  it('calls the provider base with Bearer auth and returns bounded output', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, headers: { get: () => 'application/json' }, text: async () => JSON.stringify({ me: { handle: 'alice' } }) })
    const tools = marketplaceConnectorTools(mcfg as any)
    const res = await tools[0].handler({ path: '/me' }, ctx)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.figma.com/v1/me')
    expect(init.headers.Authorization).toBe('Bearer fig-tok')
    expect((res as any).content).toContain('alice')
  })

  it('marks provider failures as errors', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 403, headers: { get: () => 'text/plain' }, text: async () => 'denied' })
    const tools = marketplaceConnectorTools(mcfg as any)
    const res = await tools[0].handler({ path: '/files/x' }, ctx)
    expect((res as any).isError).toBe(true)
    expect((res as any).content).toContain('403')
  })

  it('probe: 401 marks invalid credentials; other statuses pass', async () => {
    fetchMock.mockResolvedValueOnce({ status: 401, text: async () => 'unauthorized' })
    const bad = await probeMarketplaceConnector(mcfg as any)
    expect(bad.invalidCredentials).toBe(true)
    fetchMock.mockResolvedValueOnce({ status: 200, text: async () => '{}' })
    const good = await probeMarketplaceConnector(mcfg as any)
    expect(good.ok).toBe(true)
  })
})
