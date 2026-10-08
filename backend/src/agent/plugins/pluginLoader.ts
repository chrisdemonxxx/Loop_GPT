/**
 * Plugin/extension framework.
 *
 * A plugin bundles tools (and can declare skills/UI hooks). Built-in plugins
 * are compiled modules implementing the Plugin interface. Operator-installed
 * plugins can be loaded from backend/plugins/<id>/index.js exporting a default
 * Plugin. Users can install "data plugins" (JSON manifests of safe HTTP tools)
 * that are private to their account. Enablement is per user.
 */
import fs from 'fs'
import path from 'path'
import { configStore } from '../configStore'
import { extensionFailure, extensionRequest, validateUrlTemplate } from '../extensionHttp'
import { isReservedToolName } from '../reservedNames'
import type { ToolDefinition } from '../types'

export interface Plugin {
  id: string
  name: string
  description: string
  tools?: ToolDefinition[]
  /** Optional UI hints surfaced to the frontend. */
  ui?: { commands?: Array<{ label: string; prompt: string }> }
}

/** Example built-in plugin: quick text utilities. */
const textUtilsPlugin: Plugin = {
  id: 'text-utils',
  name: 'Text Utilities',
  description: 'Handy text tools: word count and case conversion.',
  tools: [
    {
      name: 'text_stats',
      source: 'plugin:text-utils',
      description: 'Return word, character, and line counts for a piece of text.',
      parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      async handler(args) {
        const t = String(args.text || '')
        const words = t.trim() ? t.trim().split(/\s+/).length : 0
        return { content: `words: ${words}, characters: ${t.length}, lines: ${t.split('\n').length}` }
      },
    },
  ],
  ui: { commands: [{ label: 'Count words', prompt: 'Count the words in the following text:\n' }] },
}

/** Example built-in plugin #2: time utilities (brief §2.4 — proves the plugin
 * pattern beyond text-utils). */
const timeUtilsPlugin: Plugin = {
  id: 'time-utils',
  name: 'Time Utilities',
  description: 'Time tools: convert a timestamp between timezones.',
  tools: [
    {
      name: 'convert_time',
      source: 'plugin:time-utils',
      description: 'Convert an ISO timestamp or "now" to another IANA timezone. Args: time (ISO or "now"), timeZone (e.g. Europe/Paris).',
      parameters: {
        type: 'object',
        properties: { time: { type: 'string', description: 'ISO 8601 timestamp, or "now"' }, timeZone: { type: 'string', description: 'Target IANA timezone' } },
        required: ['time', 'timeZone'],
      },
      async handler(args) {
        try {
          const when = String(args.time || '').toLowerCase() === 'now' ? new Date() : new Date(String(args.time))
          if (isNaN(when.getTime())) return { content: 'Invalid timestamp.', isError: true }
          const tz = String(args.timeZone || 'UTC')
          const formatted = new Intl.DateTimeFormat('en-GB', { timeZone: tz, dateStyle: 'full', timeStyle: 'long' }).format(when)
          return { content: `${tz}: ${formatted}` }
        } catch {
          return { content: 'Unknown timezone. Use an IANA name like Europe/Paris.', isError: true }
        }
      },
    },
  ],
}

const BUILTIN_PLUGINS: Plugin[] = [textUtilsPlugin, timeUtilsPlugin]

// ── Data plugins (brief §2.4 — installable, JSON manifests, no eval) ────────
// A data plugin bundles safe HTTP tools (like the custom-tool builder) in a
// JSON manifest stored under <AGENT_DATA_DIR>/plugins/<ownerId>/<id>.json.
// Installing never executes third-party code; tools are executed by the same
// conservative public HTTP runner the custom tools use.

interface DataToolSpec {
  name: string
  description: string
  method?: 'GET' | 'POST'
  url: string // may contain {param} placeholders in the path or query
  headers?: Record<string, string>
  params?: Array<{ name: string; type?: 'string' | 'number' | 'boolean'; description?: string; required?: boolean }>
}

export interface DataPluginManifest {
  id: string
  name: string
  description: string
  tools: DataToolSpec[]
}

const DATA_PLUGIN_DIR = path.join(process.env.AGENT_DATA_DIR || path.join(__dirname, '../../../data'), 'plugins')

function ownerDir(ownerId: string): string | null {
  return /^[A-Za-z0-9_-]{1,128}$/.test(String(ownerId || '')) ? path.join(DATA_PLUGIN_DIR, ownerId) : null
}

function manifestToPlugin(m: DataPluginManifest): Plugin {
  return {
    id: m.id,
    name: m.name,
    description: m.description,
    tools: (m.tools || []).filter((t) => !isReservedToolName(t.name)).map((t) => ({
      name: t.name,
      source: `plugin:${m.id}`,
      description: t.description,
      parameters: {
        type: 'object' as const,
        properties: Object.fromEntries((t.params || []).map((p) => [p.name, { type: p.type || 'string', description: p.description || '' }])),
        required: (t.params || []).filter((p) => p.required).map((p) => p.name),
      },
      async handler(args: any, ctx: any) {
        let origin: string
        try { origin = validateUrlTemplate(t.url) } catch (error) { return { content: extensionFailure(error), isError: true } }
        let url = t.url
        for (const p of t.params || []) {
          if (url.includes(`{${p.name}}`)) url = url.split(`{${p.name}}`).join(encodeURIComponent(String(args[p.name] ?? '')))
        }
        const query: Record<string, string> = {}
        const payload: Record<string, unknown> = {}
        for (const p of t.params || []) {
          if (t.url.includes(`{${p.name}}`)) continue
          if (args[p.name] === undefined) continue
          if ((t.method || 'GET') === 'GET') query[p.name] = String(args[p.name])
          else payload[p.name] = args[p.name]
        }
        const qs = new URLSearchParams(query).toString()
        if (qs) url = `${url}${url.includes('?') ? '&' : '?'}${qs}`
        const isPost = t.method === 'POST'
        try {
          const res = await extensionRequest(url, {
            method: isPost ? 'POST' : 'GET',
            origin,
            headers: { Accept: 'application/json', ...(isPost ? { 'Content-Type': 'application/json' } : {}), ...(t.headers || {}) },
            body: isPost ? JSON.stringify(payload) : undefined,
            signal: ctx?.signal,
            timeoutMs: 20_000,
          })
          if (!res.ok) return { content: `HTTP ${res.status}`, isError: true }
          return { content: res.text.slice(0, 6000) || '(empty response)' }
        } catch (error) {
          return { content: extensionFailure(error), isError: true }
        }
      },
    })),
  }
}

function validateManifest(m: any): DataPluginManifest | null {
  if (!m || typeof m !== 'object') return null
  const id = String(m.id || '').trim()
  const name = String(m.name || '').trim()
  if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(id)) return null
  if (!name || name.length > 60) return null
  const tools = Array.isArray(m.tools) ? m.tools.slice(0, 6) : []
  if (!tools.length) return null
  const clean: DataToolSpec[] = []
  for (const t of tools) {
    const toolName = String(t?.name || '').trim()
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,40}$/.test(toolName) || isReservedToolName(toolName)) return null
    if (!/^https?:\/\//.test(String(t?.url || ''))) return null
    try { validateUrlTemplate(String(t.url)) } catch { return null }
    const headers: Record<string, string> = {}
    if (t?.headers && typeof t.headers === 'object' && !Array.isArray(t.headers)) {
      for (const [k, v] of Object.entries(t.headers)) if (typeof v === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(k)) headers[k] = v
    }
    clean.push({
      name: toolName,
      description: String(t?.description || '').slice(0, 200),
      method: t?.method === 'POST' ? 'POST' : 'GET',
      url: String(t.url),
      headers,
      params: Array.isArray(t?.params) ? t.params.map((p: any) => ({
        name: String(p?.name || ''), type: p?.type === 'number' || p?.type === 'boolean' ? p.type : 'string',
        description: String(p?.description || ''), required: !!p?.required,
      })).filter((p: any) => /^[a-zA-Z_][a-zA-Z0-9_]{0,40}$/.test(p.name)) : [],
    })
  }
  return { id, name, description: String(m.description || '').slice(0, 300), tools: clean }
}

function loadDataPlugins(ownerId: string): Plugin[] {
  const dir = ownerDir(ownerId)
  try {
    if (!dir || !fs.existsSync(dir)) return []
    const out: Plugin[] = []
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue
      try {
        const m = validateManifest(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8')))
        if (m) out.push(manifestToPlugin(m))
      } catch { /* skip broken manifest */ }
    }
    return out
  } catch { return [] }
}

function loadExternalPlugins(): Plugin[] {
  const dir = path.join(process.cwd(), 'plugins')
  const out: Plugin[] = []
  try {
    if (!fs.existsSync(dir)) return out
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const entryPath = path.join(dir, entry.name, 'index.js')
      if (!fs.existsSync(entryPath)) continue
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const mod = require(entryPath)
        const plugin: Plugin = mod.default || mod
        if (plugin && plugin.id) out.push(plugin)
      } catch {
        /* skip broken plugin */
      }
    }
  } catch {
    /* ignore */
  }
  return out
}

export function installDataPlugin(ownerId: string, manifest: any): DataPluginManifest | { error: string } {
  const m = validateManifest(manifest)
  if (!m) return { error: 'Invalid manifest: id (kebab-case), name, 1-6 tools with public http(s) URLs and non-reserved identifier names are required.' }
  if (BUILTIN_PLUGINS.some((p) => p.id === m.id) || pluginRegistry.operatorPluginIds().has(m.id)) return { error: 'That id is reserved by a built-in plugin.' }
  const dir = ownerDir(ownerId)
  if (!dir) return { error: 'A valid plugin owner is required.' }
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, `${m.id}.json`), JSON.stringify(m, null, 2))
  return m
}

export function uninstallDataPlugin(ownerId: string, id: string): boolean {
  if (BUILTIN_PLUGINS.some((p) => p.id === id)) return false
  const dir = ownerDir(ownerId)
  if (!dir || !/^[a-z0-9][a-z0-9-]{1,40}$/.test(id)) return false
  const file = path.join(dir, `${id}.json`)
  if (!fs.existsSync(file)) return false
  fs.unlinkSync(file)
  return true
}

class PluginRegistry {
  private operator: Plugin[] | null = null

  /** Reviewed, deployment-wide plugins: compiled built-ins plus operator code. */
  private sharedPlugins(): Plugin[] {
    if (!this.operator) this.operator = loadExternalPlugins()
    return [...BUILTIN_PLUGINS, ...this.operator]
  }

  operatorPluginIds(): Set<string> {
    return new Set(this.sharedPlugins().map((p) => p.id))
  }

  init() {
    this.operator = loadExternalPlugins()
  }

  /** Every plugin the user can see: shared ones plus their own data plugins. */
  private pluginsFor(ownerId: string): Plugin[] {
    const seen = new Set<string>()
    const out: Plugin[] = []
    for (const p of [...this.sharedPlugins(), ...loadDataPlugins(ownerId)]) {
      if (seen.has(p.id)) continue
      seen.add(p.id)
      out.push(p)
    }
    return out
  }

  has(ownerId: string, id: string): boolean {
    return this.pluginsFor(ownerId).some((p) => p.id === id)
  }

  list(ownerId: string) {
    const enabled = new Set(configStore.getEnabledPlugins(ownerId))
    return this.pluginsFor(ownerId).map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      enabled: enabled.has(p.id),
      builtin: BUILTIN_PLUGINS.some((b) => b.id === p.id),
      tools: (p.tools || []).map((t) => t.name),
      ui: p.ui,
    }))
  }

  /** Tools from the user's enabled plugins. Reserved names never pass. */
  toolsFor(ownerId: string): ToolDefinition[] {
    const enabled = new Set(configStore.getEnabledPlugins(ownerId))
    return this.pluginsFor(ownerId)
      .filter((p) => enabled.has(p.id))
      .flatMap((p) => p.tools || [])
      .filter((t) => !isReservedToolName(t.name))
  }
}

export const pluginRegistry = new PluginRegistry()
