/**
 * Connector framework.
 *
 * A "connector type" knows how to turn a stored config (tokens/URLs) into a set
 * of agent tools. Connectors are enabled/configured via the config store and
 * their tools are registered with source `connector:<id>`. Ships one reference
 * connector (GitHub, token-based). OAuth-based connectors can implement the
 * same interface with an added auth route.
 */
import axios from 'axios'
import { toolRegistry } from '../toolRegistry'
import { configStore, type ConnectorConfig } from '../configStore'
import type { ToolDefinition } from '../types'
import { CONNECTOR_CATALOG, buildCatalogTools, type CatalogConnector } from './catalog'

export interface ConnectorType {
  type: string
  name: string
  description: string
  category?: string
  icon?: string
  oauth?: boolean
  /** Config fields the UI should collect (secret fields are write-only). */
  fields: Array<{ key: string; label: string; secret?: boolean; required?: boolean; placeholder?: string }>
  createTools: (cfg: ConnectorConfig) => ToolDefinition[]
}

/** Adapt a data-driven catalog entry to the ConnectorType interface. */
function catalogType(def: CatalogConnector): ConnectorType {
  return {
    type: def.type,
    name: def.name,
    description: def.description,
    category: def.category,
    icon: def.icon,
    oauth: def.oauth,
    fields: def.fields || [],
    createTools: (cfg) => buildCatalogTools(def, cfg),
  }
}

/** Reference connector: GitHub via a personal access token. */
const githubConnector: ConnectorType = {
  type: 'github',
  name: 'GitHub',
  description: 'Search GitHub and read file contents using a personal access token.',
  category: 'Developer',
  icon: '🐙',
  fields: [{ key: 'token', label: 'GitHub token', secret: true, required: true }],
  createTools(cfg) {
    const token = cfg.config.token
    const auth = token ? { Authorization: `Bearer ${token}` } : {}
    const id = cfg.id
    return [
      {
        name: `connector__${id}__github_search_repos`,
        source: `connector:${id}`,
        description: '[GitHub] Search repositories by keyword.',
        parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
        async handler(args) {
          const resp = await axios.get('https://api.github.com/search/repositories', {
            params: { q: args.query, per_page: 5 },
            headers: { ...auth, Accept: 'application/vnd.github+json' },
            timeout: 20000,
          })
          const items = (resp.data.items || []).map((r: any) => `${r.full_name} ⭐${r.stargazers_count}\n${r.description || ''}\n${r.html_url}`)
          return { content: items.join('\n\n') || 'No repositories found.' }
        },
      },
      {
        name: `connector__${id}__github_read_file`,
        source: `connector:${id}`,
        description: '[GitHub] Read a file from a repo. Args: owner, repo, path, ref (optional).',
        parameters: {
          type: 'object',
          properties: { owner: { type: 'string' }, repo: { type: 'string' }, path: { type: 'string' }, ref: { type: 'string' } },
          required: ['owner', 'repo', 'path'],
        },
        async handler(args) {
          const resp = await axios.get(`https://api.github.com/repos/${args.owner}/${args.repo}/contents/${args.path}`, {
            params: args.ref ? { ref: args.ref } : {},
            headers: { ...auth, Accept: 'application/vnd.github.raw+json' },
            timeout: 20000,
            responseType: 'text',
          })
          return { content: typeof resp.data === 'string' ? resp.data.slice(0, 8000) : JSON.stringify(resp.data).slice(0, 8000) }
        },
      },
    ]
  },
}

/** Reference connector: a generic REST/HTTP API base with optional auth header. */
const httpConnector: ConnectorType = {
  type: 'http',
  name: 'HTTP API',
  description: 'Call any REST API. Exposes an http_get tool scoped to a base URL, with an optional auth header.',
  category: 'Developer',
  icon: '🔌',
  fields: [
    { key: 'baseUrl', label: 'Base URL (e.g. https://api.example.com)', required: true },
    { key: 'authHeader', label: 'Auth header name (optional, e.g. Authorization)' },
    { key: 'authValue', label: 'Auth header value (optional)', secret: true },
  ],
  createTools(cfg) {
    const base = (cfg.config.baseUrl || '').replace(/\/+$/, '')
    const headers: Record<string, string> = {}
    if (cfg.config.authHeader && cfg.config.authValue) headers[cfg.config.authHeader] = cfg.config.authValue
    const id = cfg.id
    return [
      {
        name: `connector__${id}__http_get`,
        source: `connector:${id}`,
        description: `[${cfg.name}] GET a path from ${base}. Args: path (e.g. "/v1/items?limit=5").`,
        parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
        async handler(args) {
          const path = String(args.path || '')
          const url = path.startsWith('http') ? path : `${base}${path.startsWith('/') ? '' : '/'}${path}`
          const res = await fetch(url, { headers })
          const text = await res.text()
          if (!res.ok) return { content: `HTTP ${res.status}: ${text.slice(0, 500)}`, isError: true }
          return { content: text.slice(0, 6000) }
        },
      },
    ]
  },
}

class ConnectorRegistry {
  private types = new Map<string, ConnectorType>()

  constructor() {
    this.registerType(githubConnector)
    this.registerType(httpConnector)
    // Data-driven directory (Notion, Slack, Stripe, … + OAuth entries).
    for (const def of CONNECTOR_CATALOG) {
      if (!this.types.has(def.type)) this.registerType(catalogType(def))
    }
  }

  registerType(t: ConnectorType) {
    this.types.set(t.type, t)
  }

  listTypes() {
    return Array.from(this.types.values()).map((t) => ({
      type: t.type,
      name: t.name,
      description: t.description,
      category: t.category || 'Other',
      icon: t.icon || null,
      oauth: !!t.oauth,
      fields: t.fields,
    }))
  }

  /** Activate all enabled connectors from the config store. */
  init() {
    for (const cfg of configStore.listConnectors()) {
      if (cfg.enabled) this.activate(cfg)
    }
  }

  activate(cfg: ConnectorConfig) {
    const type = this.types.get(cfg.type)
    if (!type) return
    toolRegistry.unregisterSource(`connector:${cfg.id}`)
    for (const tool of type.createTools(cfg)) toolRegistry.register(tool)
  }

  deactivate(id: string) {
    toolRegistry.unregisterSource(`connector:${id}`)
  }
}

export const connectorRegistry = new ConnectorRegistry()
