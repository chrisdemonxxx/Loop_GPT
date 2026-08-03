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

const BUILTIN_PLUGINS: Plugin[] = [textUtilsPlugin]

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
    for (const p of [...BUILTIN_PLUGINS, ...loadExternalPlugins()]) {
      this.plugins.set(p.id, p)
    }
    // Register tools for enabled plugins.
    const enabled = new Set(configStore.getEnabledPlugins())
    for (const p of this.plugins.values()) {
      if (enabled.has(p.id)) this.enable(p.id)
    }
  }

  list() {
    const enabled = new Set(configStore.getEnabledPlugins())
    return Array.from(this.plugins.values()).map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      enabled: enabled.has(p.id),
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
