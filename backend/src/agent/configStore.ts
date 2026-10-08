/**
 * Simple JSON-file-backed config store for agent extensibility settings
 * (MCP servers, connectors, enabled skills/plugins). Works without a database,
 * consistent with the app's existing in-memory fallback pattern. Can be
 * swapped for Postgres later.
 *
 * Tenancy: every record is owned. Connectors, custom tools and MCP servers
 * carry an `ownerId`; enabled skills/plugins and tool-permission overrides are
 * stored per owner. Owner-less records written before ownership existed are
 * never served to a user (they stay readable through the `*All` admin views).
 */
import fs from 'fs'
import path from 'path'

const DATA_DIR = process.env.AGENT_DATA_DIR || path.join(__dirname, '../../data')

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true })
}

function read<T>(name: string, fallback: T): T {
  try {
    const file = path.join(DATA_DIR, `${name}.json`)
    if (!fs.existsSync(file)) return fallback
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as T
  } catch {
    return fallback
  }
}

function write<T>(name: string, value: T) {
  ensureDir()
  fs.writeFileSync(path.join(DATA_DIR, `${name}.json`), JSON.stringify(value, null, 2))
}

export interface McpServerConfig {
  id: string
  name: string
  /** Only remote (HTTP) servers can be configured through the API. */
  transport: 'stdio' | 'http'
  /** stdio: command + args. http: url. */
  command?: string
  args?: string[]
  url?: string
  headers?: Record<string, string>
  enabled: boolean
  /** Administrator who configured the server. */
  ownerId?: string
  /** When true the server's tools are offered to every user, not just the owner. */
  shared?: boolean
}

export interface ConnectorConfig {
  id: string
  type: string // e.g. 'github', 'http'
  name: string
  // Secrets are stored server-side only and never returned to the client.
  config: Record<string, string>
  enabled: boolean
  /** Connection health metadata (from the "Test connection" action). */
  lastTestedAt?: string
  lastTestOk?: boolean
  lastTestMessage?: string
  /** Display label for the connected account/workspace (no secrets). */
  account?: string
  ownerId?: string
}

export interface CustomToolParam {
  name: string
  type: 'string' | 'number' | 'boolean'
  required?: boolean
  description?: string
}

/** A user-built "webhook tool" (the plugin builder). Calls an HTTP endpoint. */
export interface CustomToolConfig {
  id: string
  name: string
  description: string
  method: 'GET' | 'POST'
  url: string // supports {param} placeholders
  headers?: Record<string, string>
  params: CustomToolParam[]
  enabled: boolean
  ownerId?: string
}

export type ToolPermission = 'allow' | 'approval' | 'blocked'

/** One tool-call audit record (append-only, bounded). */
export interface ToolAuditEntry {
  at: string
  userId: string
  conversationId: string
  tool: string
  args: string
  outcome: 'ok' | 'error' | 'denied' | 'blocked' | 'approved'
  ms: number
}

const AUDIT_CAP = 1000

/** Built-in permission defaults. Destructive execution needs approval. */
const PERMISSION_DEFAULTS: Readonly<Record<string, ToolPermission>> = Object.freeze({
  create_document: 'allow',
  web_search: 'allow',
  web_fetch: 'allow',
  calculator: 'allow',
  get_current_time: 'allow',
  generate_image: 'allow',
  generate_video: 'allow',
  execute_code: 'approval',
  create_custom_tool: 'approval',
})

type PerOwner<T> = Record<string, T>

function owned<T extends { ownerId?: string }>(items: T[], ownerId: string): T[] {
  return ownerId ? items.filter((item) => item.ownerId === ownerId) : []
}

/** Replace one owner's slice of a shared list, leaving every other owner's rows intact. */
function replaceOwned<T extends { ownerId?: string }>(all: T[], ownerId: string, next: T[]): T[] {
  if (!ownerId) throw new Error('ownerId is required')
  return [...all.filter((item) => item.ownerId !== ownerId), ...next.map((item) => ({ ...item, ownerId }))]
}

function readPerOwner<T>(name: string): PerOwner<T> {
  const value = read<unknown>(name, {})
  // Pre-tenancy files stored a single global value (an array or flat map).
  // That value belonged to nobody; it is dropped rather than shared.
  if (!value || typeof value !== 'object' || Array.isArray(value) || (value as any).__owners !== true) return {}
  return (value as any).owners || {}
}

function writePerOwner<T>(name: string, owners: PerOwner<T>) {
  write(name, { __owners: true, owners })
}

export const configStore = {
  // ── MCP servers (admin-configured) ──────────────────────────────────────
  listAllMcpServers(): McpServerConfig[] {
    return read<McpServerConfig[]>('mcp-servers', [])
  },
  saveAllMcpServers(servers: McpServerConfig[]) {
    write('mcp-servers', servers)
  },

  // ── Connectors ──────────────────────────────────────────────────────────
  listAllConnectors(): ConnectorConfig[] {
    return read<ConnectorConfig[]>('connectors', [])
  },
  listConnectors(ownerId: string): ConnectorConfig[] {
    return owned(configStore.listAllConnectors(), ownerId)
  },
  saveConnectors(ownerId: string, connectors: ConnectorConfig[]) {
    write('connectors', replaceOwned(configStore.listAllConnectors(), ownerId, connectors))
  },
  /** Update one connector in place, matched by id AND owner. */
  updateConnector(cfg: ConnectorConfig) {
    if (!cfg.ownerId) return
    write('connectors', configStore.listAllConnectors().map((c) => (c.id === cfg.id && c.ownerId === cfg.ownerId ? cfg : c)))
  },

  // ── Skills / plugins enablement ─────────────────────────────────────────
  getEnabledSkills(ownerId: string): string[] {
    return ownerId ? readPerOwner<string[]>('enabled-skills')[ownerId] || [] : []
  },
  setEnabledSkills(ownerId: string, ids: string[]) {
    if (!ownerId) throw new Error('ownerId is required')
    const all = readPerOwner<string[]>('enabled-skills')
    all[ownerId] = [...new Set(ids)]
    writePerOwner('enabled-skills', all)
  },
  getEnabledPlugins(ownerId: string): string[] {
    return ownerId ? readPerOwner<string[]>('enabled-plugins')[ownerId] || [] : []
  },
  setEnabledPlugins(ownerId: string, ids: string[]) {
    if (!ownerId) throw new Error('ownerId is required')
    const all = readPerOwner<string[]>('enabled-plugins')
    all[ownerId] = [...new Set(ids)]
    writePerOwner('enabled-plugins', all)
  },

  // ── Custom webhook tools ────────────────────────────────────────────────
  listAllCustomTools(): CustomToolConfig[] {
    return read<CustomToolConfig[]>('custom-tools', [])
  },
  listCustomTools(ownerId: string): CustomToolConfig[] {
    return owned(configStore.listAllCustomTools(), ownerId)
  },
  saveCustomTools(ownerId: string, tools: CustomToolConfig[]) {
    write('custom-tools', replaceOwned(configStore.listAllCustomTools(), ownerId, tools))
  },

  // ── Tool permissions ────────────────────────────────────────────────────
  /** Per-tool permission overrides for one user: allow | approval | blocked.
   *  Built-in document/search tools allow by default. Destructive execution
   *  and anything the user explicitly sets still win. */
  getToolPermissions(ownerId?: string): Record<string, ToolPermission> {
    const mine = ownerId ? readPerOwner<Record<string, ToolPermission>>('tool-permissions')[ownerId] || {} : {}
    return { ...PERMISSION_DEFAULTS, ...mine }
  },
  setToolPermission(ownerId: string, name: string, level: ToolPermission) {
    if (!ownerId) throw new Error('ownerId is required')
    const all = readPerOwner<Record<string, ToolPermission>>('tool-permissions')
    const map = { ...(all[ownerId] || {}) }
    const implicit = PERMISSION_DEFAULTS[name] || 'allow'
    if (level === implicit) delete map[name]
    else map[name] = level
    all[ownerId] = map
    writePerOwner('tool-permissions', all)
  },

  // ── Audit ───────────────────────────────────────────────────────────────
  /** Append a tool-call audit record; the log is bounded (most recent kept). */
  appendToolAudit(entry: ToolAuditEntry) {
    const log = read<ToolAuditEntry[]>('tool-audit', [])
    log.push(entry)
    write('tool-audit', log.slice(-AUDIT_CAP))
  },
  /**
   * Most recent audit entries, newest first. With `opts.userId`, only that
   * user's entries are returned (multi-tenant isolation — the filter applies
   * BEFORE the cap so a user's older entries aren't crowded out by others').
   */
  listToolAudit(limit = 100, opts?: { userId?: string }): ToolAuditEntry[] {
    const log = read<ToolAuditEntry[]>('tool-audit', [])
    const entries = opts?.userId ? log.filter((e) => e.userId === opts.userId) : log
    return entries.slice(-Math.min(Math.max(limit, 1), AUDIT_CAP)).reverse()
  },
}
