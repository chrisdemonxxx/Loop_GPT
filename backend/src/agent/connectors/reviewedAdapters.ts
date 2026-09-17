/** Reviewed read-only operations. No arbitrary paths, headers or destinations. */
import { z } from 'zod'
import type { ToolParameterSchema } from '../types'
import type { PublicHttpOptions, PublicHttpResponse } from '../../services/publicHttp'

const searchInput = z.object({ query: z.string().trim().min(1).max(500), limit: z.number().int().min(1).max(20).default(10) }).strict()
const tokenInput = z.string().min(1).max(8000).regex(/^[\x21-\x7e]+$/)
const parameters: ToolParameterSchema = { type: 'object', additionalProperties: false,
  properties: { query: { type: 'string', minLength: 1, maxLength: 500 }, limit: { type: 'integer', minimum: 1, maximum: 20, default: 10 } }, required: ['query'] }

export function isReviewedConnector(type: string): boolean { return type === 'notion' || type === 'gitlab' }
export function connectionToolName(id: string): string {
  return `connection_${z.string().uuid().parse(id).replace(/-/g, '')}_search`
}

function redact(value: unknown, token: string, max: number): string {
  if (typeof value !== 'string') return ''
  // Redact before truncation/serialization, including percent-encoded echoes.
  return value.split(token).join('[REDACTED]').split(encodeURIComponent(token)).join('[REDACTED]').slice(0, max)
}
function safeLink(value: unknown, token: string): string | null {
  if (typeof value !== 'string' || value.length > 8192) return null
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password) return null
    return redact(url.href, token, 2048)
  } catch { return null }
}
function parseResponse(response: PublicHttpResponse): any {
  const value = JSON.parse(response.body.toString('utf8'))
  if (value === null || typeof value !== 'object') throw new Error('Invalid provider response')
  return value
}
function boundedSummary(results: unknown[], hasMore: boolean): string {
  let content = JSON.stringify({ results, hasMore, page: 1 })
  while (Buffer.byteLength(content) > 16384 && results.length) {
    results.pop(); hasMore = true
    content = JSON.stringify({ results, hasMore, page: 1 })
  }
  return content
}
function notionTitle(row: any): string {
  if (Array.isArray(row?.title)) return row.title.map((part: any) => typeof part?.plain_text === 'string' ? part.plain_text : '').join('')
  if (!row?.properties || typeof row.properties !== 'object') return ''
  for (const property of Object.values(row.properties) as any[]) {
    if (property?.type === 'title' && Array.isArray(property.title)) return property.title.map((part: any) => typeof part?.plain_text === 'string' ? part.plain_text : '').join('')
  }
  return ''
}

export function reviewedAdapter(type: string) {
  if (!isReviewedConnector(type)) return undefined
  const notion = type === 'notion'
  return {
    parameters,
    description: notion
      ? 'Search titles of Notion pages and databases shared with this workspace connection. Read-only, first page only, at most 20 results.'
      : 'Search GitLab.com projects the connected account belongs to. Read-only metadata, first page only, at most 20 results.',
    build(args: unknown, rawToken: unknown): { url: string; options: PublicHttpOptions; limit: number; token: string } {
      const { query, limit } = searchInput.parse(args)
      const token = tokenInput.parse(rawToken)
      if (notion) return { url: 'https://api.notion.com/v1/search', token, limit, options: {
        method: 'POST', redirects: 0, allowedOrigins: ['https://api.notion.com'], maxBytes: 512 * 1024, timeoutMs: 15000,
        headers: { Authorization: `Bearer ${token}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ query, page_size: limit }),
      } }
      const url = new URL('https://gitlab.com/api/v4/projects')
      url.search = new URLSearchParams({ search: query, membership: 'true', simple: 'true', per_page: String(limit), page: '1' }).toString()
      return { url: url.href, token, limit, options: { method: 'GET', redirects: 0, allowedOrigins: ['https://gitlab.com'], maxBytes: 512 * 1024, timeoutMs: 15000,
        headers: { 'PRIVATE-TOKEN': token, Accept: 'application/json' },
      } }
    },
    summarize(response: PublicHttpResponse, token: string, limit: number): string {
      const value = parseResponse(response)
      if (notion) {
        if (!Array.isArray(value.results)) throw new Error('Invalid Notion results')
        const results = value.results.slice(0, limit).map((row: any) => ({
          id: redact(row?.id, token, 128), kind: row?.object === 'page' ? 'page' : row?.object === 'database' ? 'database' : 'other',
          title: redact(notionTitle(row), token, 500), url: safeLink(row?.url, token),
        }))
        return boundedSummary(results, value.has_more === true || value.results.length > limit)
      }
      if (!Array.isArray(value)) throw new Error('Invalid GitLab results')
      const results = value.slice(0, limit).map((row: any) => ({
        id: typeof row?.id === 'number' && Number.isSafeInteger(row.id) ? row.id : null,
        name: redact(row?.name, token, 500), path: redact(row?.path_with_namespace, token, 500), url: safeLink(row?.web_url, token),
      }))
      const next = response.headers['x-next-page']
      return boundedSummary(results, (typeof next === 'string' && /^\d+$/.test(next) && Number(next) > 1) || value.length > limit)
    },
  }
}
