/**
 * MCP registry: connects configured MCP servers and exposes their tools to the
 * agent's tool registry. Tools are namespaced as `mcp__<serverId>__<tool>`.
 */
import { McpConnection } from './mcpClient'
import { toolRegistry } from '../toolRegistry'
import { configStore, type McpServerConfig } from '../configStore'
import type { ToolContext } from '../types'

interface ActiveServer {
  cfg: McpServerConfig
  conn: McpConnection
  toolNames: string[]
  status: 'connected' | 'error'
  error?: string
}

class McpRegistry {
  private servers = new Map<string, ActiveServer>()

  status() {
    return Array.from(this.servers.values()).map((s) => ({
      id: s.cfg.id,
      name: s.cfg.name,
      status: s.status,
      error: s.error,
      tools: s.toolNames,
    }))
  }

  /** Connect all enabled servers from the config store (best-effort). */
  async init() {
    const configs = configStore.listMcpServers().filter((s) => s.enabled)
    await Promise.all(configs.map((c) => this.connectServer(c).catch(() => undefined)))
  }

  async connectServer(cfg: McpServerConfig) {
    await this.disconnectServer(cfg.id)
    const conn = new McpConnection(cfg)
    try {
      await conn.connect()
      const tools = await conn.listTools()
      const toolNames: string[] = []
      for (const t of tools) {
        const nsName = `mcp__${cfg.id}__${t.name}`
        toolNames.push(nsName)
        toolRegistry.register({
          name: nsName,
          source: `mcp:${cfg.id}`,
          description: `[${cfg.name}] ${t.description}`,
          parameters: t.inputSchema || { type: 'object', properties: {} },
          handler: async (args: Record<string, any>, _ctx: ToolContext) => {
            const out = await conn.callTool(t.name, args)
            return { content: out }
          },
        })
      }
      this.servers.set(cfg.id, { cfg, conn, toolNames, status: 'connected' })
      return { ok: true, tools: toolNames }
    } catch (error: any) {
      this.servers.set(cfg.id, { cfg, conn, toolNames: [], status: 'error', error: error?.message })
      return { ok: false, error: error?.message }
    }
  }

  async disconnectServer(id: string) {
    const existing = this.servers.get(id)
    if (existing) {
      toolRegistry.unregisterSource(`mcp:${id}`)
      await existing.conn.close()
      this.servers.delete(id)
    }
  }
}

export const mcpRegistry = new McpRegistry()
