/**
 * Plugin/extension framework.
 *
 * A plugin bundles tools (and can declare skills/UI hooks). Built-in plugins
 * are compiled modules implementing the Plugin interface; each is enabled or
 * disabled via the config store. This mirrors how Claude.ai "extensions" add
 * capabilities without touching core code. Third-party plugins can be loaded
 * from backend/plugins/<id>/index.js exporting a default Plugin.
 */
import fs from 'fs'
import path from 'path'
import { toolRegistry } from '../toolRegistry'
import { configStore } from '../configStore'
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
// JSON manifest stored under <AGENT_DATA_DIR>/plugins/<id>.json. Installing
// never executes third-party code; tools are executed by the same conservative
// HTTP runner the custom tools use.

interface DataToolSpec {
  name: string
  description: string
  method?: 'GET' | 'POST'
  url: string // may contain {param} placeholders
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

function manifestToPlugin(m: DataPluginManifest): Plugin {
  return {
    id: m.id,
    name: m.name,
    description: m.description,
    tools: (m.tools || []).map((t) => ({
      name: t.name,
      source: `plugin:${m.id}`,
      description: t.description,
      parameters: {
        type: 'object' as const,
        properties: Object.fromEntries((t.params || []).map((p) => [p.name, { type: p.type || 'string', description: p.description || '' }])),
        required: (t.params || []).filter((p) => p.required).map((p) => p.name),
      },
      async handler(args: any) {
        let url = t.url
        for (const p of t.params || []) {
          if (url.includes(`{${p.name}}`)) url = url.replaceAll(`{${p.name}}`, encodeURIComponent(String(args[p.name] ?? '')))
        }
        const query: Record<string, string> = {}
        let body: string | undefined
        for (const p of t.params || []) {
          if (url.includes(`{${p.name}}`)) continue
          if (args[p.name] === undefined) continue
          if ((t.method || 'GET') === 'GET') query[p.name] = String(args[p.name])
          else body = JSON.stringify({ ...(body ? JSON.parse(body) : {}), [p.name]: args[p.name] })
        }
        try {
          const res = await fetch(url, {
            method: t.method || 'GET',
            headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}), ...(t.headers || {}) },
            body,
            signal: AbortSignal.timeout(20_000),
          })
          const text = await res.text()
          if (!res.ok) return { content: `HTTP ${res.status}: ${text.slice(0, 400)}`, isError: true }
          return { content: text.slice(0, 6000) || '(empty response)' }
        } catch (e: any) {
          return { content: `Request failed: ${e?.message || e}`, isError: true }
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
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,40}$/.test(toolName)) return null
    if (!/^https?:\/\//.test(String(t?.url || ''))) return null
    clean.push({
      name: toolName,
      description: String(t?.description || '').slice(0, 200),
      method: t?.method === 'POST' ? 'POST' : 'GET',
      url: String(t.url),
      headers: t?.headers && typeof t.headers === 'object' ? t.headers : {},
      params: Array.isArray(t?.params) ? t.params.map((p: any) => ({
        name: String(p?.name || ''), type: p?.type === 'number' || p?.type === 'boolean' ? p.type : 'string',
        description: String(p?.description || ''), required: !!p?.required,
      })).filter((p: any) => p.name) : [],
    })
  }
  return { id, name, description: String(m.description || '').slice(0, 300), tools: clean }
}

export function installDataPlugin(manifest: any): DataPluginManifest | { error: string } {
  const m = validateManifest(manifest)
  if (!m) return { error: 'Invalid manifest: id (kebab-case), name, 1-6 tools with https URLs and identifier names are required.' }
  if (BUILTIN_PLUGINS.some((p) => p.id === m.id)) return { error: 'That id is reserved by a built-in plugin.' }
  fs.mkdirSync(DATA_PLUGIN_DIR, { recursive: true })
  fs.writeFileSync(path.join(DATA_PLUGIN_DIR, `${m.id}.json`), JSON.stringify(m, null, 2))
  pluginRegistry.reload()
  return m
}

export function uninstallDataPlugin(id: string): boolean {
  if (BUILTIN_PLUGINS.some((p) => p.id === id)) return false
  const file = path.join(DATA_PLUGIN_DIR, `${id}.json`)
  if (!fs.existsSync(file)) return false
  pluginRegistry.disable(id)
  fs.unlinkSync(file)
  pluginRegistry.reload()
  return true
}

function loadDataPlugins(): Plugin[] {
  try {
    if (!fs.existsSync(DATA_PLUGIN_DIR)) return []
    const out: Plugin[] = []
    for (const f of fs.readdirSync(DATA_PLUGIN_DIR)) {
      if (!f.endsWith('.json')) continue
      try {
        const m = JSON.parse(fs.readFileSync(path.join(DATA_PLUGIN_DIR, f), 'utf-8'))
        const plugin = manifestToPlugin(m)
        if (plugin.id) out.push(plugin)
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

class PluginRegistry {
  private plugins = new Map<string, Plugin>()

  init() {
    this.plugins.clear()
    for (const p of [...BUILTIN_PLUGINS, ...loadExternalPlugins(), ...loadDataPlugins()]) {
      this.plugins.set(p.id, p)
    }
    // Register tools for enabled plugins.
    const enabled = new Set(configStore.getEnabledPlugins())
    for (const p of this.plugins.values()) {
      if (enabled.has(p.id)) this.enable(p.id)
    }
  }

  /** Re-scan plugin sources (after install/uninstall). */
  reload() {
    const enabled = new Set(configStore.getEnabledPlugins())
    for (const id of [...this.plugins.keys()]) {
      if (!BUILTIN_PLUGINS.some((p) => p.id === id)) toolRegistry.unregisterSource(`plugin:${id}`)
    }
    this.init()
    for (const id of enabled) this.enable(id)
  }

  list() {
    const enabled = new Set(configStore.getEnabledPlugins())
    return Array.from(this.plugins.values()).map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      enabled: enabled.has(p.id),
      builtin: BUILTIN_PLUGINS.some((b) => b.id === p.id),
      tools: (p.tools || []).map((t) => t.name),
      ui: p.ui,
    }))
  }

  enable(id: string) {
    const p = this.plugins.get(id)
    if (!p) return
    for (const tool of p.tools || []) toolRegistry.register(tool)
  }

  disable(id: string) {
    toolRegistry.unregisterSource(`plugin:${id}`)
  }
}

export const pluginRegistry = new PluginRegistry()
