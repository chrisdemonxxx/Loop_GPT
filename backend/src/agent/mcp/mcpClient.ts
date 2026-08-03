/**
 * MCP (Model Context Protocol) client wrapper.
 *
 * Connects to an MCP server over stdio (local process) or Streamable HTTP
 * (remote), lists its tools, and calls them.
 *
 * The @modelcontextprotocol/sdk package is ESM-only, which cannot be `require`d
 * from our CommonJS build. We therefore load it via a native dynamic import
 * (through `Function` so TypeScript does not down-level it to require()). The
 * SDK is only needed when MCP is actually used.
 */
import type { McpServerConfig } from '../configStore'

// Preserve a real ESM dynamic import at runtime (TS would otherwise rewrite it).
const importESM: (m: string) => Promise<any> = new Function('m', 'return import(m)') as any

export interface McpToolInfo {
  name: string
  description: string
  inputSchema: any
}

export class McpConnection {
  private client: any = null
  private connected = false

  constructor(private cfg: McpServerConfig) {}

  async connect(): Promise<void> {
    if (this.connected) return
    const { Client } = await importESM('@modelcontextprotocol/sdk/client/index.js')
    this.client = new Client({ name: 'loop-gpt', version: '1.0.0' }, { capabilities: {} })

    if (this.cfg.transport === 'stdio') {
      if (!this.cfg.command) throw new Error('stdio MCP server requires a command')
      const { StdioClientTransport } = await importESM('@modelcontextprotocol/sdk/client/stdio.js')
      const transport = new StdioClientTransport({ command: this.cfg.command, args: this.cfg.args || [] })
      await this.client.connect(transport)
    } else {
      if (!this.cfg.url) throw new Error('http MCP server requires a url')
      const { StreamableHTTPClientTransport } = await importESM('@modelcontextprotocol/sdk/client/streamableHttp.js')
      const transport = new StreamableHTTPClientTransport(new URL(this.cfg.url), {
        requestInit: { headers: this.cfg.headers || {} },
      })
      await this.client.connect(transport)
    }
    this.connected = true
  }

  async listTools(): Promise<McpToolInfo[]> {
    const res = await this.client.listTools()
    return (res.tools || []).map((t: any) => ({
      name: t.name,
      description: t.description || '',
      inputSchema: t.inputSchema || { type: 'object', properties: {} },
    }))
  }

  async callTool(name: string, args: Record<string, any>): Promise<string> {
    const res: any = await this.client.callTool({ name, arguments: args })
    const parts = (res.content || []) as any[]
    const text = parts
      .map((p) => (p.type === 'text' ? p.text : p.type === 'resource' ? JSON.stringify(p.resource) : `[${p.type}]`))
      .join('\n')
    return text || '(no output)'
  }

  async close(): Promise<void> {
    if (this.connected && this.client) {
      try {
        await this.client.close()
      } catch {
        /* ignore */
      }
      this.connected = false
    }
  }
}
