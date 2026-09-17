import { describe, expect, it } from 'vitest'
import { connectionToolName, reviewedAdapter } from '../connectors/reviewedAdapters'

const token = 'fixture-token-with-private-value'
const response = (body: unknown, headers = {}) => ({ body: Buffer.from(JSON.stringify(body)), status: 200, url: 'https://provider.example.com', headers })

describe('reviewed read-only request construction', () => {
  it('creates bounded Notion search JSON with a fixed URL/version and no redirects', () => {
    const request = reviewedAdapter('notion')!.build({ query: '"},"url":"http://127.0.0.1', limit: 5 }, token)
    expect(request.url).toBe('https://api.notion.com/v1/search')
    expect(request.options).toMatchObject({ method: 'POST', redirects: 0, timeoutMs: 15000, maxBytes: 524288, allowedOrigins: ['https://api.notion.com'] })
    expect(request.options.headers).toMatchObject({ Authorization: `Bearer ${token}`, 'Notion-Version': '2022-06-28' })
    expect(JSON.parse(request.options.body as string)).toEqual({ query: '"},"url":"http://127.0.0.1', page_size: 5 })
  })
  it('encodes GitLab queries without changing path, membership filter, or page limits', () => {
    const request = reviewedAdapter('gitlab')!.build({ query: '../projects?membership=false&per_page=1000' }, token)
    const url = new URL(request.url)
    expect(url.origin + url.pathname).toBe('https://gitlab.com/api/v4/projects')
    expect(url.searchParams.get('search')).toBe('../projects?membership=false&per_page=1000')
    expect(url.searchParams.get('membership')).toBe('true')
    expect(url.searchParams.get('per_page')).toBe('10')
    expect(url.searchParams.get('page')).toBe('1')
    expect(request.options).toMatchObject({ method: 'GET', redirects: 0, allowedOrigins: ['https://gitlab.com'], headers: { 'PRIVATE-TOKEN': token } })
    expect(request.options.body).toBeUndefined()
  })
  it.each(['notion', 'gitlab'])('rejects undeclared fields and invalid arguments for %s', (type) => {
    const adapter = reviewedAdapter(type)!
    for (const args of [{ query: '' }, { query: ' ' }, { query: 'q', limit: 21 }, { query: 'q', limit: 1.5 },
      { query: 'q', url: 'https://other.example.com' }, { query: 'q', token: 'override' }]) expect(() => adapter.build(args, token)).toThrow()
    expect(() => adapter.build({ query: 'q' }, 'bad\r\nheader')).toThrow()
  })
  it('returns no adapter for unsupported types and uses distinct model-compatible names', () => {
    expect(reviewedAdapter('slack')).toBeUndefined()
    expect(reviewedAdapter('__proto__')).toBeUndefined()
    const name = connectionToolName('11111111-1111-4111-8111-111111111111')
    expect(name).toMatch(/^[A-Za-z0-9_]{1,64}$/)
    expect(name).not.toBe(connectionToolName('22222222-2222-4222-8222-222222222222'))
  })
  it('extracts only bounded Notion metadata and redacts before truncating', () => {
    const body = { results: [{ id: `id-${token}`, object: 'page', properties: { Name: { type: 'title', title: [{ plain_text: 'x'.repeat(495) + token }] }, SecretProperty: token }, url: `https://www.notion.so/${token}` }], has_more: true }
    const content = reviewedAdapter('notion')!.summarize(response(body), token, 10)
    expect(content).not.toContain(token)
    expect(content).not.toContain('SecretProperty')
    const result = JSON.parse(content)
    expect(result.results[0].title.length).toBeLessThanOrEqual(500)
    expect(result.results[0].title).toBe('x'.repeat(495) + '[REDA')
    expect(result.hasMore).toBe(true)
  })
  it('extracts GitLab metadata, omits extra data and rejects unsafe link schemes', () => {
    const body = [{ id: 7, name: token, path_with_namespace: 'team/repo', web_url: 'javascript:alert(1)', description: 'Private unrequested field' }]
    const content = reviewedAdapter('gitlab')!.summarize(response(body, { 'x-next-page': '2' }), token, 10)
    expect(content).not.toContain(token)
    expect(content).not.toContain('Private unrequested field')
    expect(JSON.parse(content)).toMatchObject({ results: [{ id: 7, name: '[REDACTED]', url: null }], hasMore: true, page: 1 })
    const encodedToken = 'fixture/token+value'
    const encoded = reviewedAdapter('gitlab')!.summarize(response([{ id: 8, name: encodeURIComponent(encodedToken),
      web_url: `https://gitlab.com/${encodeURIComponent(encodedToken)}` }]), encodedToken, 10)
    expect(encoded).not.toContain(encodeURIComponent(encodedToken))
    expect(JSON.parse(encoded).results[0].name).toBe('[REDACTED]')
  })
  it('limits aggregate summary bytes while retaining valid JSON and indicating omitted results', () => {
    const rows = Array.from({ length: 20 }, () => ({ id: 1, name: 'n'.repeat(500), path_with_namespace: 'p'.repeat(500), web_url: `https://gitlab.com/${'a'.repeat(2000)}` }))
    const content = reviewedAdapter('gitlab')!.summarize(response(rows), token, 20)
    expect(Buffer.byteLength(content)).toBeLessThanOrEqual(16384)
    expect(JSON.parse(content).hasMore).toBe(true)
    expect(JSON.parse(content).results.length).toBeLessThan(20)
  })
  it.each(['notion', 'gitlab'])('rejects malformed %s responses', (type) => {
    const adapter = reviewedAdapter(type)!
    expect(() => adapter.summarize(response(null), token, 10)).toThrow()
    expect(() => adapter.summarize(response({ wrong: true }), token, 10)).toThrow()
    expect(() => adapter.summarize({ ...response({}), body: Buffer.from('{invalid-json') }, token, 10)).toThrow()
  })
})
