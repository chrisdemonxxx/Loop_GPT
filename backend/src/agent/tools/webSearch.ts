/**
 * web_search tool: search the web.
 *
 * Priority order (per the platform spec):
 *  1. SearXNG    — the org's self-hosted metasearch Space (SEARXNG_URL)
 *  2. Brave      — when BRAVE_API_KEY is set (reliable fallback)
 *  3. Tavily     — when TAVILY_API_KEY is set (structured fallback)
 *  4. DuckDuckGo HTML — no key, best-effort scrape
 *  5. Bing HTML  — no key fallback (scrapes bing.com)
 *
 * Candidate passages are reranked with bge-reranker-v2-m3 when available
 * (fail-open), matching the spec's search pipeline.
 */
import { JSDOM } from 'jsdom'
import type { ToolDefinition } from '../types'
import { postPublicForm as postForm, postPublicJson as postJson, getPublicJson, fetchPublicText, PublicHttpError, validatePublicUrl } from '../../services/publicHttp'
import { rerank } from '../../services/embeddingStore'

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
      if (bounded.length >= 50) break
    }
    return await refineResults(query, bounded, maxResults)
  }
  finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel) }
}

function checkCancelled(signal: AbortSignal) {
  if (signal.aborted) throw signal.reason
}

/**
 * Rerank candidate results against the query with bge-reranker-v2-m3.
 * Fail-open: if the reranker is unavailable, keep provider order.
 */
const STOPWORDS = new Set(['the', 'a', 'an', 'of', 'to', 'in', 'for', 'and', 'or', 'on', 'with', 'is', 'are',
  'was', 'be', 'at', 'by', 'from', 'as', 'it', 'its', 'this', 'that', 'what', 'how', 'why', 'when', 'who',
  'best', 'vs', 'into', 'over', 'about', 'after', 'before', 'than', 'then', 'you', 'your'])

function queryTokens(query: string): string[] {
  return (query.toLowerCase().match(/[a-z0-9][a-z0-9.+#-]{1,}/g) || [])
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t))
}

/**
 * Deterministic lexical relevance: keep results whose title/snippet share query
 * terms, ranked by overlap. Prevents loosely-matching engine noise (e.g. "hug"
 * for "Hugging Face") when the reranker is unavailable. Never empties the set.
 */
function lexicalFilter(query: string, candidates: SearchResult[]): SearchResult[] {
  const tokens = queryTokens(query)
  if (tokens.length === 0) return candidates
  const scored = candidates.map((c) => {
    const hay = `${c.title} ${c.snippet} ${c.url}`.toLowerCase()
    let hits = 0
    for (const t of tokens) if (hay.includes(t)) hits++
    return { c, hits }
  })
  const matched = scored.filter((s) => s.hits > 0).sort((a, b) => b.hits - a.hits).map((s) => s.c)
  return matched.length > 0 ? matched : candidates
}

async function refineResults(query: string, candidates: SearchResult[], maxResults: number): Promise<SearchResult[]> {
  const filtered = lexicalFilter(query, candidates)
  if (process.env.SEARCH_RERANK === 'false' || filtered.length <= maxResults) return filtered.slice(0, maxResults)
  try {
    const docs = filtered.map((c) => `${c.title}\n${c.snippet}`.slice(0, 2000))
    const scored = await rerank(query, docs)
    if (!Array.isArray(scored) || scored.length === 0) return filtered.slice(0, maxResults)
    const ordered = scored
      .filter((s) => Number.isInteger(s.index) && filtered[s.index])
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .map((s) => filtered[s.index])
    const seen = new Set(ordered.map((r) => r.url))
    for (const c of filtered) if (!seen.has(c.url)) ordered.push(c)
    return ordered.slice(0, maxResults)
  } catch {
    return filtered.slice(0, maxResults)
  }
}

/** The org's self-hosted SearXNG metasearch endpoint. */
function searxngBase(): string {
  if (process.env.SEARXNG_ENABLED === 'false') return ''
  return (process.env.SEARXNG_URL || process.env.SEARXNG_ENDPOINT_URL || '').replace(/\/+$/, '')
}

async function searxngSearch(query: string, maxResults: number, signal: AbortSignal): Promise<SearchResult[]> {
  const base = searxngBase()
  if (!base) return []
  const origin = new URL(base).origin
  const headers: Record<string, string> = { Accept: 'application/json' }
  const token = process.env.SEARXNG_TOKEN || process.env.SEARXNG_API_TOKEN
  if (token) {
    headers.Authorization = `Bearer ${token}`
    headers['X-API-Key'] = token
  }
  const url = `${base}/search?q=${encodeURIComponent(query)}&format=json&safesearch=0`
  const data = await getPublicJson<any>(url, { signal, maxBytes: 1024 * 1024, allowedOrigins: [origin], headers })
  const rows = Array.isArray(data?.results) ? data.results : []
  return rows
    .map((r: any) => ({ title: String(r.title || r.url || ''), url: String(r.url || ''), snippet: String(r.content || '') }))
    .filter((r: SearchResult) => r.url.startsWith('http'))
}

async function searchWithProviders(query: string, maxResults: number, signal: AbortSignal): Promise<SearchResult[]> {
  // 1. SearXNG (self-hosted HF Space) — primary.
  checkCancelled(signal)
  if (searxngBase()) {
    try {
      const res = await searxngSearch(query, maxResults, signal)
      if (res.length > 0) return res
    } catch { /* fall through */ }
  }

  // 2. Brave — reliable keyed fallback.
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

  // 3. Tavily — structured keyed fallback.
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

  // 4. DuckDuckGo HTML scrape — no key; 5. Bing HTML fallback.
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

/**
 * Bing wraps some results in /ck/a?...&u=a1<base64url>. Decode back to the
 * real destination so citations are clean.
 */
function decodeBingRedirect(href: string): string {
  try {
    if (!href.includes('bing.com/ck/a')) return href
    const u = new URL(href).searchParams.get('u')
    if (!u || !u.startsWith('a1')) return href
    const b64 = u.slice(2).replace(/-/g, '+').replace(/_/g, '/')
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4)
    const decoded = Buffer.from(padded, 'base64').toString('utf-8')
    return decoded.startsWith('http') ? decoded : href
  } catch { return href }
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
      const href = decodeBingRedirect(a.getAttribute('href') || '')
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
