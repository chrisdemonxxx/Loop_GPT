/**
 * Simple JSON-file-backed config store for agent extensibility settings
 * (MCP servers, connectors, enabled skills/plugins). Works without a database,
 * consistent with the app's existing in-memory fallback pattern. Can be
 * swapped for Postgres later.
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
  transport: 'stdio' | 'http'
  /** stdio: command + args. http: url. */
  command?: string
  args?: string[]
  url?: string
  headers?: Record<string, string>
  enabled: boolean
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

export const configStore = {
  listMcpServers(): McpServerConfig[] {
    return read<McpServerConfig[]>('mcp-servers', [])
  },
  saveMcpServers(servers: McpServerConfig[]) {
    write('mcp-servers', servers)
  },
  listConnectors(): ConnectorConfig[] {
    return read<ConnectorConfig[]>('connectors', [])
  },
  saveConnectors(connectors: ConnectorConfig[]) {
    write('connectors', connectors)
  },
  getEnabledSkills(): string[] {
    return read<string[]>('enabled-skills', [])
  },
  setEnabledSkills(ids: string[]) {
    write('enabled-skills', ids)
  },
  getEnabledPlugins(): string[] {
    return read<string[]>('enabled-plugins', [])
  },
  setEnabledPlugins(ids: string[]) {
    write('enabled-plugins', ids)
  },
  listCustomTools(): CustomToolConfig[] {
    return read<CustomToolConfig[]>('custom-tools', [])
  },
  saveCustomTools(tools: CustomToolConfig[]) {
    write('custom-tools', tools)
  },
  /** Per-tool permission overrides: allow | approval | blocked. */
  getToolPermissions(): Record<string, ToolPermission> {
    return read<Record<string, ToolPermission>>('tool-permissions', {})
  },
  setToolPermission(name: string, level: ToolPermission) {
    const map = read<Record<string, ToolPermission>>('tool-permissions', {})
    if (level === 'allow' && !map[name]) return
    map[name] = level
    write('tool-permissions', map)
  },
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
