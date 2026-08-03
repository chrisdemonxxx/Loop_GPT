/**
 * Custom "webhook tools" — the in-app plugin/tool builder.
 *
 * Users define a tool that calls an HTTP endpoint (no arbitrary code execution).
 * Each becomes a first-class agent tool sourced as `custom:<id>`. The URL may
 * contain {param} placeholders; remaining params are sent as a JSON body (POST)
 * or query string (GET).
 */
import { toolRegistry } from './toolRegistry'
import { configStore, type CustomToolConfig } from './configStore'
import { fetchText } from './httpClient'
import type { ToolDefinition } from './types'

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
    async handler(args) {
      // Substitute {param} placeholders in the URL and collect the rest.
      let url = cfg.url
      const used = new Set<string>()
      url = url.replace(/\{(\w+)\}/g, (_m, key) => {
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
          const text = await fetchText(full, { headers: cfg.headers, timeoutMs: 30000 })
          return { content: text.slice(0, 6000) }
        }
        // POST with JSON body.
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(cfg.headers || {}) },
          body: JSON.stringify(rest),
        })
        const text = await res.text()
        if (!res.ok) return { content: `HTTP ${res.status}: ${text.slice(0, 500)}`, isError: true }
        return { content: text.slice(0, 6000) }
      } catch (e: any) {
        return { content: `Request failed: ${e?.message || e}`, isError: true }
      }
    },
  }
}

export const customToolRegistry = {
  /** Register all enabled custom tools at startup. */
  init() {
    for (const cfg of configStore.listCustomTools()) {
      if (cfg.enabled) toolRegistry.register(toToolDefinition(cfg))
    }
  },
  list(): CustomToolConfig[] {
    return configStore.listCustomTools()
  },
  upsert(cfg: CustomToolConfig) {
    const tools = configStore.listCustomTools()
    const idx = tools.findIndex((t) => t.id === cfg.id)
    if (idx >= 0) tools[idx] = cfg
    else tools.push(cfg)
    configStore.saveCustomTools(tools)
    toolRegistry.unregisterSource(`custom:${cfg.id}`)
    if (cfg.enabled) toolRegistry.register(toToolDefinition(cfg))
  },
  remove(id: string) {
    configStore.saveCustomTools(configStore.listCustomTools().filter((t) => t.id !== id))
    toolRegistry.unregisterSource(`custom:${id}`)
  },
}
