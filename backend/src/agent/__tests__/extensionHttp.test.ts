import { afterEach, describe, expect, it, vi } from 'vitest'
import { extensionRequest, publicFetch, scopedUrl, validateUrlTemplate } from '../extensionHttp'
import { McpConnection } from '../mcp/mcpClient'

afterEach(() => { vi.unstubAllEnvs() })

describe('scopedUrl keeps model-supplied paths on the configured origin', () => {
  const base = 'https://api.example.com/v1'
  it.each([
    ['/me', 'https://api.example.com/v1/me'],
    ['items?limit=5', 'https://api.example.com/v1/items?limit=5'],
    ['?q=x', 'https://api.example.com/v1?q=x'],
  ])('joins %s', (path, expected) => {
    expect(scopedUrl(base, path)).toBe(expected)
  })
  it.each([
    'https://evil.example.net/steal',
    'http://169.254.169.254/latest/meta-data',
    '//evil.example.net/x',
    'javascript:alert(1)',
    'file:///etc/passwd',
    '\\\\evil.example.net\\share',
    '/x\r\nHost: evil',
  ])('refuses %j', (path) => {
    expect(() => scopedUrl(base, path)).toThrow()
  })
  it.each(['@evil.example.net/x', '/../../../admin', '%2F%2Fevil.example.net'])('keeps %j on the configured host', (path) => {
    expect(new URL(scopedUrl(base, path)).origin).toBe('https://api.example.com')
  })
  it.each(['http://127.0.0.1:8080', 'http://localhost', 'http://10.0.0.5/api', 'http://[::1]/', 'http://169.254.169.254'])(
    'refuses a private configured base %s', (privateBase) => {
      expect(() => scopedUrl(privateBase, '/x')).toThrow()
    })
})

describe('validateUrlTemplate', () => {
  it('returns the fixed origin of a public template', () => {
    expect(validateUrlTemplate('https://hooks.example.com/run/{id}?q={q}')).toBe('https://hooks.example.com')
  })
  it.each([
    'https://{tenant}.example.com/x',
    'https://example.com{path}',
    'http://{host}/x',
    'http://127.0.0.1/{x}',
    'http://192.168.1.1/hook',
    'gopher://example.com/x',
    'https://user:pass@example.com/x',
  ])('refuses %s', (template) => {
    expect(() => validateUrlTemplate(template)).toThrow()
  })
})

describe('extensionRequest / publicFetch origin lock', () => {
  it('refuses a request that left the configured origin before any network call', async () => {
    await expect(extensionRequest('https://other.example.net/x', { origin: 'https://api.example.com' })).rejects.toThrow(/origin/i)
  })
  it('refuses a private destination', async () => {
    await expect(extensionRequest('http://127.0.0.1:5432/')).rejects.toThrow()
  })
  it('does not open long-lived GET streams for MCP', async () => {
    const res = await publicFetch('https://mcp.example.com')('https://mcp.example.com/mcp', { method: 'GET' })
    expect(res.status).toBe(405)
  })
})

describe('MCP transports', () => {
  it('refuses stdio servers unless the operator opted in', async () => {
    vi.stubEnv('MCP_ALLOW_STDIO', '')
    const conn = new McpConnection({ id: 's', name: 's', transport: 'stdio', command: 'node', args: ['-e', 'process.exit(1)'], enabled: true } as any)
    await expect(conn.connect()).rejects.toThrow(/stdio MCP servers are disabled/)
  })
  it('refuses an http server on a private address', async () => {
    const conn = new McpConnection({ id: 'h', name: 'h', transport: 'http', url: 'http://127.0.0.1:9000/mcp', enabled: true } as any)
    await expect(conn.connect()).rejects.toThrow(/private|blocked|not allowed|permitted/i)
  })
})
