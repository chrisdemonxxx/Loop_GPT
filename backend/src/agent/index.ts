/**
 * Agent bootstrap: register built-in tools and initialize the extensibility
 * registries (MCP servers, connectors, plugins). Call initAgent() once at
 * server startup.
 */
import { toolRegistry } from './toolRegistry'
import { webSearchTool } from './tools/webSearch'
import { webFetchTool } from './tools/webFetch'
import { currentTimeTool, calculatorTool } from './tools/utility'
import { generateImageTool } from './tools/generateImage'
import { createDocumentTool } from './tools/createDocument'
import { createSkillTool, createCustomToolTool } from './tools/metaTools'
import { mcpRegistry } from './mcp/mcpRegistry'
import { connectorRegistry } from './connectors/connectorRegistry'
import { pluginRegistry } from './plugins/pluginLoader'
import { customToolRegistry } from './customTools'

const BUILTIN_TOOLS = [
  webSearchTool,
  webFetchTool,
  currentTimeTool,
  calculatorTool,
  generateImageTool,
  createDocumentTool,
  createSkillTool,
  createCustomToolTool,
]

export function registerBuiltinTools() {
  for (const tool of BUILTIN_TOOLS) toolRegistry.register(tool)
}

/** Names of the always-available built-in tools (used as the default toolset). */
export function builtinToolNames(): string[] {
  return BUILTIN_TOOLS.map((t) => t.name)
}

export async function initAgent() {
  registerBuiltinTools()
  // Connectors and plugins are synchronous; MCP connects over the network.
  try {
    connectorRegistry.init()
  } catch (e) {
    console.warn('Connector init failed:', (e as any)?.message)
  }
  try {
    pluginRegistry.init()
  } catch (e) {
    console.warn('Plugin init failed:', (e as any)?.message)
  }
  try {
    customToolRegistry.init()
  } catch (e) {
    console.warn('Custom tools init failed:', (e as any)?.message)
  }
  try {
    await mcpRegistry.init()
  } catch (e) {
    console.warn('MCP init failed:', (e as any)?.message)
  }
  console.log(`🧰 Agent ready — ${toolRegistry.list().length} tools registered`)
}

export { toolRegistry }
