/**
 * web_fetch tool: download a URL and extract its readable text content.
 */
import { JSDOM } from 'jsdom'
import { Readability } from '@mozilla/readability'
import type { ToolDefinition } from '../types'
import { fetchText } from '../httpClient'

export async function fetchReadable(url: string, maxChars = 6000): Promise<{ title: string; text: string }> {
  const html = await fetchText(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; LoopGPT-Agent/1.0; +https://github.com/chrisdemonxxx/loop_gpt)',
      Accept: 'text/html,application/xhtml+xml',
    },
  })
  const dom = new JSDOM(html, { url })
  const reader = new Readability(dom.window.document)
  const article = reader.parse()
  const title = article?.title || dom.window.document.title || url
  let text = (article?.textContent || dom.window.document.body?.textContent || '').replace(/\s+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
  if (text.length > maxChars) text = text.slice(0, maxChars) + `\n…[truncated]`
  return { title, text }
}

export const webFetchTool: ToolDefinition = {
  name: 'web_fetch',
  source: 'builtin',
  description: 'Fetch a web page by URL and return its main readable text content. Use after web_search to read a specific source.',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'The absolute URL to fetch (http/https).' },
    },
    required: ['url'],
  },
  async handler(args) {
    const url = String(args.url || '')
    if (!/^https?:\/\//i.test(url)) {
      return { content: 'Error: url must be an absolute http(s) URL.', isError: true }
    }
    try {
      const { title, text } = await fetchReadable(url)
      return { content: `# ${title}\nSource: ${url}\n\n${text}`, data: { url, title } }
    } catch (error: any) {
      return { content: `Failed to fetch ${url}: ${error?.message || error}`, isError: true }
    }
  },
}
