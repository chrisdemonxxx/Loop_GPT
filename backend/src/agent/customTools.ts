/**
 * Custom "webhook tools" — the in-app plugin/tool builder.
 *
 * Users define a tool that calls an HTTP endpoint (no arbitrary code execution).
 * Each becomes an agent tool sourced as `custom:<id>`, visible only to the
 * account that created it. The URL may contain {param} placeholders in its
 * path or query; remaining params are sent as a JSON body (POST) or query
 * string (GET). Requests stay on the configured public origin.
 */
import { configStore, type CustomToolConfig, type CustomToolParam } from './configStore'
import { extensionFailure, extensionRequest, validateUrlTemplate } from './extensionHttp'
import { isReservedToolName } from './reservedNames'
import type { ToolDefinition } from './types'

export class CustomToolError extends Error {}

const NAME_RE = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/
const MAX_TOOLS_PER_USER = 50

function toToolDefinition(cfg: CustomToolConfig): ToolDefinition {
  const properties: Record<string, any> = {}
  for (const p of cfg.params) {
    properties[p.name] = { type: p.type || 'string', description: p.description || '' }
  }
  return {
    name: cfg.name,
    source: `custom:${cfg.id}`,
    description: cfg.description,
    parameters: { type: 'object', properties, required: cfg.params.filter((p) => p.required).map((p) => p.name) },
    async handler(args, ctx) {
      let origin: string
      try { origin = validateUrlTemplate(cfg.url) } catch (error) { return { content: extensionFailure(error), isError: true } }
      // Substitute {param} placeholders in the URL and collect the rest.
      const used = new Set<string>()
      const url = cfg.url.replace(/\{(\w+)\}/g, (_m, key) => {
        used.add(key)
        return encodeURIComponent(String(args[key] ?? ''))
      })
      const rest: Record<string, any> = {}
      for (const [k, v] of Object.entries(args)) if (!used.has(k)) rest[k] = v

      try {
        if (cfg.method === 'GET') {
          const qs = new URLSearchParams(
            Object.fromEntries(Object.entries(rest).map(([k, v]) => [k, String(v)]))
          ).toString()
          const full = qs ? `${url}${url.includes('?') ? '&' : '?'}${qs}` : url
          const res = await extensionRequest(full, { headers: cfg.headers, origin, signal: ctx?.signal, timeoutMs: 30_000 })
          if (!res.ok) return { content: `HTTP ${res.status}`, isError: true }
          return { content: res.text.slice(0, 6000) }
        }
        const res = await extensionRequest(url, {
          method: 'POST', origin, signal: ctx?.signal, timeoutMs: 30_000,
          headers: { 'Content-Type': 'application/json', ...(cfg.headers || {}) },
          body: JSON.stringify(rest),
        })
        if (!res.ok) return { content: `HTTP ${res.status}`, isError: true }
        return { content: res.text.slice(0, 6000) }
      } catch (error) {
        return { content: extensionFailure(error), isError: true }
      }
    },
  }
}

function cleanParams(raw: unknown): CustomToolParam[] {
  if (!Array.isArray(raw)) return []
  return raw.slice(0, 20).map((p: any) => ({
    name: String(p?.name || '').trim(),
    type: p?.type === 'number' || p?.type === 'boolean' ? p.type : 'string',
    description: String(p?.description || '').slice(0, 300),
    required: !!p?.required,
  })).filter((p) => /^[a-zA-Z_][a-zA-Z0-9_]{0,40}$/.test(p.name)) as CustomToolParam[]
}

function cleanHeaders(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>).slice(0, 20)) {
    if (typeof v === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(k)) out[k] = v
  }
  return out
}

/** Validate untrusted input into a storable config. Throws CustomToolError. */
export function buildCustomTool(ownerId: string, input: {
  id: string; name: unknown; description?: unknown; method?: unknown; url: unknown; headers?: unknown; params?: unknown
}): CustomToolConfig {
  const name = String(input.name || '').trim()
  const url = String(input.url || '').trim()
  if (!name || !url) throw new CustomToolError('name and url are required')
  if (!NAME_RE.test(name)) throw new CustomToolError('name must be a valid identifier (letters, numbers, underscores; no spaces)')
  if (isReservedToolName(name)) throw new CustomToolError('That tool name is reserved by a built-in tool')
  try { validateUrlTemplate(url) } catch { throw new CustomToolError('url must be a public http(s) address without placeholders in the host') }
  const existing = configStore.listCustomTools(ownerId)
  if (existing.some((t) => t.name === name && t.id !== input.id)) throw new CustomToolError('You already have a tool with that name')
  if (!existing.some((t) => t.id === input.id) && existing.length >= MAX_TOOLS_PER_USER) throw new CustomToolError('Custom tool limit reached')
  return {
    id: input.id,
    name,
    description: String(input.description || `Custom tool ${name}`).slice(0, 500),
    method: input.method === 'GET' ? 'GET' : 'POST',
    url,
    headers: cleanHeaders(input.headers),
    params: cleanParams(input.params),
    enabled: true,
    ownerId,
  }
}

export const customToolRegistry = {
  list(ownerId: string): CustomToolConfig[] {
    return configStore.listCustomTools(ownerId)
  },
  /** The owner's enabled custom tools as agent tool definitions. */
  toolsFor(ownerId: string): ToolDefinition[] {
    return configStore.listCustomTools(ownerId)
      .filter((cfg) => cfg.enabled && !isReservedToolName(cfg.name))
      .map(toToolDefinition)
  },
  upsert(ownerId: string, cfg: CustomToolConfig) {
    const tools = configStore.listCustomTools(ownerId)
    const idx = tools.findIndex((t) => t.id === cfg.id)
    const next = { ...cfg, ownerId }
    if (idx >= 0) tools[idx] = next
    else tools.push(next)
    configStore.saveCustomTools(ownerId, tools)
  },
  remove(ownerId: string, id: string): boolean {
    const tools = configStore.listCustomTools(ownerId)
    if (!tools.some((t) => t.id === id)) return false
    configStore.saveCustomTools(ownerId, tools.filter((t) => t.id !== id))
    return true
  },
}
