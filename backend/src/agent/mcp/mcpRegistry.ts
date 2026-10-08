/**
 * MCP registry: connects configured MCP servers and keeps their tools, namespaced
 * as `mcp__<serverId>__<tool>`. Tools are never registered globally; a run only
 * sees servers its user owns, plus servers an admin marked `shared`.
 */
import { McpConnection } from './mcpClient'
import { loopitBuiltinTools } from './loopitBuiltin'
import { configStore, type McpServerConfig } from '../configStore'
import type { ToolContext, ToolDefinition } from '../types'

interface ActiveServer {
  cfg: McpServerConfig
  conn: McpConnection
  tools: ToolDefinition[]
  status: 'connected' | 'error'
  error?: string
}

const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/

class McpRegistry {
  private servers = new Map<string, ActiveServer>()

  status() {
    return Array.from(this.servers.values()).map((s) => ({
      id: s.cfg.id,
      name: s.cfg.name,
      status: s.status,
      error: s.error,
      tools: s.tools.map((t) => t.name),
    }))
  }

  /** Tools from servers visible to `userId` (owned by them, or shared),
   * plus the code-configured loopit-mcp tools when LOOPIT_MCP_URL is set. */
  toolsFor(userId: string): ToolDefinition[] {
    const out: ToolDefinition[] = userId ? loopitBuiltinTools() : []
    const seen = new Set(out.map((tool) => tool.name))
    for (const s of this.servers.values()) {
      if (s.status !== 'connected' || !s.cfg.enabled) continue
      if (!s.cfg.shared && s.cfg.ownerId !== userId) continue
      for (const tool of s.tools) {
        if (seen.has(tool.name)) continue
        seen.add(tool.name)
        out.push(tool)
      }
    }
    return out
  }

  /** Connect all enabled servers from the config store (best-effort). */
  async init() {
    const configs = configStore.listAllMcpServers().filter((s) => s.enabled)
    await Promise.all(configs.map((c) => this.connectServer(c).catch(() => undefined)))
  }

  async connectServer(cfg: McpServerConfig) {
    await this.disconnectServer(cfg.id)
    const conn = new McpConnection(cfg)
    try {
      await conn.connect()
      const listed = await conn.listTools()
      const tools: ToolDefinition[] = []
      for (const t of listed) {
        if (!TOOL_NAME.test(String(t.name || ''))) continue
        const nsName = `mcp__${cfg.id}__${t.name}`
        if (nsName.length > 128) continue
        tools.push({
          name: nsName,
          source: `mcp:${cfg.id}`,
          description: `[${cfg.name}] ${String(t.description || '').slice(0, 1000)}`,
          parameters: t.inputSchema || { type: 'object', properties: {} },
          handler: async (args: Record<string, any>, _ctx: ToolContext) => {
            const out = await conn.callTool(t.name, args)
            return { content: out }
          },
        })
      }
      this.servers.set(cfg.id, { cfg, conn, tools, status: 'connected' })
      return { ok: true, tools: tools.map((t) => t.name) }
    } catch (error: any) {
      this.servers.set(cfg.id, { cfg, conn, tools: [], status: 'error', error: error?.message })
      return { ok: false, error: error?.message }
    }
  }

  async disconnectServer(id: string) {
    const existing = this.servers.get(id)
    if (existing) {
      this.servers.delete(id)
      await existing.conn.close().catch(() => undefined)
    }
  }
}

export const mcpRegistry = new McpRegistry()
