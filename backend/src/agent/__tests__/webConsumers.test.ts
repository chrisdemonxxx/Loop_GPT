import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const requests = vi.hoisted(() => ({ request: vi.fn(), json: vi.fn(), post: vi.fn(), form: vi.fn(), text: vi.fn() }))
vi.mock('../../services/publicHttp', async (original) => ({
  ...await original<typeof import('../../services/publicHttp')>(),
  publicRequest: requests.request, getPublicJson: requests.json, postPublicJson: requests.post,
  postPublicForm: requests.form, fetchPublicText: requests.text,
}))
import { searchWeb } from '../tools/webSearch'
import { fetchReadable, webFetchTool } from '../tools/webFetch'

beforeEach(() => {
  for (const mock of Object.values(requests)) mock.mockReset()
  vi.stubEnv('TAVILY_API_KEY', ''); vi.stubEnv('BRAVE_API_KEY', '')
})
afterEach(() => vi.unstubAllEnvs())

describe('web consumers use the public-network boundary', () => {
  it('reads HTML with bounded redirects/body, forwards cancellation and never executes scripts', async () => {
    const control = new AbortController()
    requests.request.mockResolvedValue({ url: 'https://public.example.com/final', body: Buffer.from('<html><head><title>Fixture</title></head><body><script>document.title="Changed"</script><article><p>Public content</p></article></body></html>') })
    const result = await fetchReadable('https://public.example.com/start', 6000, control.signal)
    expect(result.title).toBe('Fixture')
    expect(result.text).toContain('Public content')
    expect(requests.request).toHaveBeenCalledWith('https://public.example.com/start', expect.objectContaining({ redirects: 3, maxBytes: 1024 * 1024, signal: control.signal }))
  })
  it('does not expose transport exception contents to the model', async () => {
    requests.request.mockRejectedValue(new Error('provider-secret'))
    const result = await webFetchTool.handler({ url: 'https://public.example.com' }, { userId: 'fixture', conversationId: 'fixture', scratch: {}, emit: () => {} })
    expect(result.isError).toBe(true)
    expect(result.content).not.toContain('provider-secret')
  })
  it('sends Tavily credentials only to its fixed origin and bounds results', async () => {
    vi.stubEnv('TAVILY_API_KEY', 'fixture-tavily-key')
    requests.post.mockResolvedValue({ results: [
      { url: 'http://127.0.0.1/admin', title: 'Private' },
      ...Array.from({ length: 12 }, (_, i) => ({ url: `https://public.example.com/${i}`, title: 't'.repeat(700), content: 'c'.repeat(10000) })),
    ] })
    const result = await searchWeb('fixture', 2)
    expect(result).toHaveLength(2)
    expect(result[0].title).toHaveLength(500)
    expect(result[0].snippet).toHaveLength(8000)
    expect(requests.post).toHaveBeenCalledWith('https://api.tavily.com/search', expect.any(Object), expect.objectContaining({
      allowedOrigins: ['https://api.tavily.com'], maxBytes: 512 * 1024, headers: { Authorization: 'Bearer fixture-tavily-key' },
    }))
    expect(requests.post.mock.calls[0][2].redirects).toBeUndefined()
  })
  it('uses a fixed Brave origin and falls back without forwarding its credential', async () => {
    vi.stubEnv('BRAVE_API_KEY', 'fixture-brave-key')
    requests.json.mockRejectedValue(new Error('Provider unavailable'))
    requests.form.mockResolvedValue('<div class="result"><a class="result__a" href="https://public.example.com/article">Source</a><div class="result__snippet">Snippet</div></div>')
    expect(await searchWeb('fixture')).toEqual([{ url: 'https://public.example.com/article', title: 'Source', snippet: 'Snippet' }])
    expect(requests.json.mock.calls[0][1]).toMatchObject({ allowedOrigins: ['https://api.search.brave.com'], headers: { 'X-Subscription-Token': 'fixture-brave-key' } })
    expect(JSON.stringify(requests.form.mock.calls)).not.toContain('fixture-brave-key')
  })
  it('routes Bing fallback through the bounded client', async () => {
    requests.form.mockRejectedValue(new Error('Unavailable'))
    requests.text.mockResolvedValue('<li class="b_algo"><h2><a href="https://public.example.com/article">Source</a></h2><div class="b_caption"><p>Snippet</p></div></li>')
    expect(await searchWeb('fixture')).toHaveLength(1)
    expect(requests.text.mock.calls[0][1]).toMatchObject({ allowedOrigins: ['https://www.bing.com'], maxBytes: 1024 * 1024 })
  })

  it('decodes Bing /ck/a redirects to the real destination', async () => {
    const target = 'https://public.example.com/real-article'
    const encoded = Buffer.from(target, 'utf-8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    requests.form.mockRejectedValue(new Error('Unavailable'))
    requests.text.mockResolvedValue(`<li class="b_algo"><h2><a href="https://www.bing.com/ck/a?!&&u=a1${encoded}&ntb=1">Title</a></h2><div class="b_caption"><p>Snippet</p></div></li>`)
    const results = await searchWeb('fixture')
    expect(results).toHaveLength(1)
    expect(results[0].url).toBe(target)
  })
  it('does not start another provider after cancellation', async () => {
    // Provider order is SearXNG -> Brave -> Tavily -> DDG -> Bing. With no
    // SEARXNG_URL configured, Brave is the first provider and cancelling it
    // must stop the chain before Tavily (post) or DuckDuckGo (form).
    const control = new AbortController()
    vi.stubEnv('BRAVE_API_KEY', 'fixture-brave-key')
    vi.stubEnv('TAVILY_API_KEY', 'fixture-tavily-key')
    requests.json.mockImplementation(async () => { control.abort(); throw new Error('cancelled') })
    await expect(searchWeb('fixture', 6, control.signal)).rejects.toMatchObject({ code: 'aborted' })
    expect(requests.post).not.toHaveBeenCalled()
    expect(requests.form).not.toHaveBeenCalled()
  })
  it('drops lexically irrelevant results and keeps the on-topic one first', async () => {
    requests.form.mockResolvedValue([
      '<div class="result"><a class="result__a" href="https://noise.example/chair">Office chair height</a><div class="result__snippet">desk ergonomics</div></div>',
      '<div class="result"><a class="result__a" href="https://hf.example/pricing">Hugging Face Inference Endpoints pricing</a><div class="result__snippet">inference endpoints pricing plans</div></div>',
    ].join(''))
    const results = await searchWeb('Hugging Face Inference Endpoints pricing')
    expect(results).toHaveLength(1)
    expect(results[0].url).toBe('https://hf.example/pricing')
  })

  it('rejects oversized queries and invalid limits without contacting a provider', async () => {
    await expect(searchWeb('x'.repeat(2001))).rejects.toThrow('Invalid search request')
    await expect(searchWeb('query', Infinity)).rejects.toThrow('Invalid search request')
    await expect(fetchReadable('https://public.example.com', -1)).rejects.toThrow('Invalid readable-text limit')
    expect(requests.post).not.toHaveBeenCalled()
    expect(requests.request).not.toHaveBeenCalled()
  })
})
