/**
 * web_search tool: search the web.
 *
 * Priority order:
 *  1. Tavily    — when TAVILY_API_KEY is set (highest quality, structured)
 *  2. Brave     — when BRAVE_API_KEY is set (free 2k/mo tier, reliable)
 *  3. DuckDuckGo HTML — no key, best-effort scrape
 *  4. Bing HTML  — no key fallback (scrapes bing.com)
 */
import { JSDOM } from 'jsdom'
import type { ToolDefinition } from '../types'
import { postPublicForm as postForm, postPublicJson as postJson, getPublicJson, fetchPublicText, PublicHttpError, validatePublicUrl } from '../../services/publicHttp'

export interface SearchResult {
  title: string
  url: string
  snippet: string
}

const DDG_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

export async function searchWeb(query: string, maxResults = 6, signal?: AbortSignal): Promise<SearchResult[]> {
  if (typeof query !== 'string' || !query.trim() || query.length > 2000 || !Number.isInteger(maxResults) || maxResults < 1 || maxResults > 10) throw new PublicHttpError('invalid_request', 'Invalid search request')
  const control = new AbortController()
  const cancel = () => control.abort(new PublicHttpError('aborted', 'Search cancelled'))
  const timer = setTimeout(() => control.abort(new PublicHttpError('timeout', 'Search timed out')), 30000)
  signal?.addEventListener('abort', cancel, { once: true })
  if (signal?.aborted) cancel()
  try {
    const results = await searchWithProviders(query, maxResults, control.signal)
    const bounded: SearchResult[] = []
    for (const result of results.slice(0, 50)) {
      try {
        const url = validatePublicUrl(result.url).href
        bounded.push({ url, title: typeof result.title === 'string' ? result.title.slice(0, 500) : url,
          snippet: typeof result.snippet === 'string' ? result.snippet.slice(0, 8000) : '' })
      } catch { continue }
      if (bounded.length >= maxResults) break
    }
    return bounded
  }
  finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel) }
}

function checkCancelled(signal: AbortSignal) {
  if (signal.aborted) throw signal.reason
}

async function searchWithProviders(query: string, maxResults: number, signal: AbortSignal): Promise<SearchResult[]> {
  checkCancelled(signal)
  const tavilyKey = process.env.TAVILY_API_KEY
  if (tavilyKey) {
    try {
      const data = await postJson<any>(
        'https://api.tavily.com/search',
        { query, max_results: maxResults, search_depth: 'advanced', include_answer: false },
        { signal, maxBytes: 512 * 1024, allowedOrigins: ['https://api.tavily.com'], headers: { Authorization: `Bearer ${tavilyKey}` } }
      )
      const res = (data.results || []).map((r: any) => ({ title: r.title, url: r.url, snippet: r.content || '' }))
      if (res.length > 0) return res
    } catch { /* fall through */ }
  }

  checkCancelled(signal)
  const braveKey = process.env.BRAVE_API_KEY
  if (braveKey) {
    try {
      const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${maxResults}`
      const data = await getPublicJson(url, { signal, maxBytes: 512 * 1024, allowedOrigins: ['https://api.search.brave.com'], headers: { Accept: 'application/json', 'X-Subscription-Token': braveKey } })
      const items = (data.web?.results || []).map((r: any) => ({ title: r.title, url: r.url, snippet: r.description || '' }))
      if (items.length > 0) return items
    } catch { /* fall through */ }
  }

  // DuckDuckGo HTML scrape — try first, Bing as fallback
  checkCancelled(signal)
  try {
    const results = await duckDuckGoSearch(query, maxResults, signal)
    if (results.length > 0) return results
  } catch { /* fall through */ }

  // Bing HTML scrape
  checkCancelled(signal)
  try {
    const results = await bingSearch(query, maxResults, signal)
    if (results.length > 0) return results
  } catch { /* fall through */ }

  checkCancelled(signal)
  return []
}

async function duckDuckGoSearch(query: string, maxResults: number, signal: AbortSignal): Promise<SearchResult[]> {
  const html = await postForm('https://html.duckduckgo.com/html/', { q: query }, {
    signal, maxBytes: 1024 * 1024, allowedOrigins: ['https://html.duckduckgo.com'],
    headers: { 'User-Agent': DDG_UA },
  })
  const dom = new JSDOM(html)
  try {
    const doc = dom.window.document
    const results: SearchResult[] = []
    const selectors = [
      { container: '.result', link: 'a.result__a', snippet: '.result__snippet' },
      { container: '.web-result', link: 'a[data-testid="result-title-a"]', snippet: '[data-testid="result-snippet"]' },
      { container: 'article', link: 'h2 a', snippet: 'p' },
      { container: '.results_links_deep', link: 'a.large', snippet: '.result__snippet' },
    ]
    for (const sel of selectors) {
      const nodes = doc.querySelectorAll(sel.container)
      if (nodes.length === 0) continue
      nodes.forEach((node) => {
        if (results.length >= maxResults) return
        const a = node.querySelector(sel.link) as HTMLAnchorElement | null
        const snippetEl = node.querySelector(sel.snippet)
        if (!a) return
        let href = a.getAttribute('href') || ''
        const m = href.match(/[?&]uddg=([^&]+)/)
        if (m) href = decodeURIComponent(m[1])
        if (!href.startsWith('http')) return
        results.push({ title: a.textContent?.trim() || href, url: href, snippet: snippetEl?.textContent?.trim() || '' })
      })
      if (results.length > 0) return results
    }

    // Last-resort: grab external anchors from the response.
    const anchors = Array.from(doc.querySelectorAll('a[href]')) as HTMLAnchorElement[]
    for (const a of anchors) {
      if (results.length >= maxResults) break
      let href = a.getAttribute('href') || ''
      const m = href.match(/[?&]uddg=([^&]+)/)
      if (m) href = decodeURIComponent(m[1])
      if (!href.startsWith('http') || href.includes('duckduckgo.com')) continue
      const title = a.textContent?.trim()
      if (!title || title.length < 5) continue
      results.push({ title, url: href, snippet: '' })
    }
    return results
  } finally { dom.window.close() }
}

async function bingSearch(query: string, maxResults: number, signal: AbortSignal): Promise<SearchResult[]> {
  const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}&count=${maxResults}`
  const html = await fetchPublicText(url, {
    signal, maxBytes: 1024 * 1024, allowedOrigins: ['https://www.bing.com'],
    headers: {
      'User-Agent': DDG_UA,
      Accept: 'text/html',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  })
  const dom = new JSDOM(html)
  try {
    const doc = dom.window.document
    const results: SearchResult[] = []
    const items = doc.querySelectorAll('li.b_algo')
    items.forEach((item) => {
      if (results.length >= maxResults) return
      const a = item.querySelector('h2 a') as HTMLAnchorElement | null
      const snippetEl = item.querySelector('.b_caption p') || item.querySelector('p')
      if (!a) return
      const href = a.getAttribute('href') || ''
      if (!href.startsWith('http')) return
      results.push({ title: a.textContent?.trim() || href, url: href, snippet: snippetEl?.textContent?.trim() || '' })
    })
    return results
  } finally { dom.window.close() }
}

export const webSearchTool: ToolDefinition = {
  name: 'web_search',
  source: 'builtin',
  description: 'Search the web for up-to-date information. Returns a list of results with titles, URLs, and snippets. Follow up with web_fetch to read a source in full.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', minLength: 1, maxLength: 2000, description: 'The search query.' },
      max_results: { type: 'integer', minimum: 1, maximum: 10, description: 'Number of results (default 6).' },
    },
    required: ['query'],
  },
  async handler(args, ctx) {
    const query = String(args.query || '').trim()
    if (!query) return { content: 'Error: query is required.', isError: true }
    const max = Math.min(Math.max(Number(args.max_results) || 6, 1), 10)
    try {
      const results = await searchWeb(query, max, ctx.signal)
      if (results.length === 0) return { content: `No results for "${query}".`, data: { results: [] } }
      const text = results
        .map((r, i) => `[${i + 1}] ${r.title}\n${r.url}\n${r.snippet}`)
        .join('\n\n')
      return { content: text, data: { results } }
    } catch {
      return { content: 'Search could not complete within the public-network policy and resource limits.', isError: true }
    }
  },
}
