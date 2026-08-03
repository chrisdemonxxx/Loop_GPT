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
import { postForm, postJson } from '../httpClient'

export interface SearchResult {
  title: string
  url: string
  snippet: string
}

const DDG_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

export async function searchWeb(query: string, maxResults = 6): Promise<SearchResult[]> {
  const tavilyKey = process.env.TAVILY_API_KEY
  if (tavilyKey) {
    try {
      const data = await postJson<any>(
        'https://api.tavily.com/search',
        { query, max_results: maxResults, search_depth: 'advanced', include_answer: false },
        { headers: { Authorization: `Bearer ${tavilyKey}` } }
      )
      const res = (data.results || []).map((r: any) => ({ title: r.title, url: r.url, snippet: r.content || '' }))
      if (res.length > 0) return res
    } catch { /* fall through */ }
  }

  const braveKey = process.env.BRAVE_API_KEY
  if (braveKey) {
    try {
      const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${maxResults}`
      const res = await fetch(url, { headers: { Accept: 'application/json', 'Accept-Encoding': 'gzip', 'X-Subscription-Token': braveKey } })
      if (res.ok) {
        const data = await res.json()
        const items = (data.web?.results || []).map((r: any) => ({ title: r.title, url: r.url, snippet: r.description || '' }))
        if (items.length > 0) return items
      }
    } catch { /* fall through */ }
  }

  // DuckDuckGo HTML scrape — try first, Bing as fallback
  try {
    const results = await duckDuckGoSearch(query, maxResults)
    if (results.length > 0) return results
  } catch { /* fall through */ }

  // Bing HTML scrape
  try {
    const results = await bingSearch(query, maxResults)
    if (results.length > 0) return results
  } catch { /* fall through */ }

  return []
}

async function duckDuckGoSearch(query: string, maxResults: number): Promise<SearchResult[]> {
  const html = await postForm('https://html.duckduckgo.com/html/', { q: query }, {
    headers: { 'User-Agent': DDG_UA },
  })
  const dom = new JSDOM(html)
  const doc = dom.window.document
  const results: SearchResult[] = []

  // Try multiple selector variants (DDG changes their markup)
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
      results.push({
        title: a.textContent?.trim() || href,
        url: href,
        snippet: snippetEl?.textContent?.trim() || '',
      })
    })
    if (results.length > 0) return results
  }

  // Last-resort: grab all external anchor tags from the response
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
}

async function bingSearch(query: string, maxResults: number): Promise<SearchResult[]> {
  const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}&count=${maxResults}`
  const res = await fetch(url, {
    headers: {
      'User-Agent': DDG_UA,
      Accept: 'text/html',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  })
  if (!res.ok) return []
  const html = await res.text()
  const dom = new JSDOM(html)
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
    results.push({
      title: a.textContent?.trim() || href,
      url: href,
      snippet: snippetEl?.textContent?.trim() || '',
    })
  })
  return results
}

export const webSearchTool: ToolDefinition = {
  name: 'web_search',
  source: 'builtin',
  description: 'Search the web for up-to-date information. Returns a list of results with titles, URLs, and snippets. Follow up with web_fetch to read a source in full.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'The search query.' },
      max_results: { type: 'number', description: 'Number of results (default 6).' },
    },
    required: ['query'],
  },
  async handler(args) {
    const query = String(args.query || '').trim()
    if (!query) return { content: 'Error: query is required.', isError: true }
    const max = Math.min(Math.max(Number(args.max_results) || 6, 1), 10)
    try {
      const results = await searchWeb(query, max)
      if (results.length === 0) return { content: `No results for "${query}".`, data: { results: [] } }
      const text = results
        .map((r, i) => `[${i + 1}] ${r.title}\n${r.url}\n${r.snippet}`)
        .join('\n\n')
      return { content: text, data: { results } }
    } catch (error: any) {
      return { content: `Search failed: ${error?.message || error}`, isError: true }
    }
  },
}
