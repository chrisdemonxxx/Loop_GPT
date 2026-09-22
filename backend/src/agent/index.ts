/**
 * Agent bootstrap: register reviewed built-ins and the user-configured
 * extensions (plugins, connectors, custom tools, MCP servers). Call
 * initAgent() once at server startup.
 */
import { toolRegistry } from './toolRegistry'
import { webSearchTool } from './tools/webSearch'
import { webFetchTool } from './tools/webFetch'
import { currentTimeTool, calculatorTool } from './tools/utility'
import { generateImageTool } from './tools/generateImage'
import { generateVideoTool } from './tools/generateVideo'
import { createDocumentTool } from './tools/createDocument'
import { transcribeTool } from './tools/transcribe'
import { searchKnowledgeTool } from './tools/searchKnowledge'
import { rememberTool } from './tools/remember'
import { generateStyleTool } from './tools/generateStyle'
import { speakTool } from './tools/speakText'
import { ocrTool } from './tools/ocr'
import { executeCodeTool } from './tools/executeCode'
import { createSkillTool, createCustomToolTool } from './tools/metaTools'
import { pluginRegistry } from './plugins/pluginLoader'
import { connectorRegistry } from './connectors/connectorRegistry'
import { customToolRegistry } from './customTools'
import { mcpRegistry } from './mcp/mcpRegistry'

const BUILTIN_TOOLS = [
  webSearchTool,
  webFetchTool,
  currentTimeTool,
  calculatorTool,
  generateImageTool,
  generateVideoTool,
  createDocumentTool,
  transcribeTool,
  speakTool,
  ocrTool,
  executeCodeTool,
  searchKnowledgeTool,
  rememberTool,
  generateStyleTool,
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

/** Reviewed definitions, independent of registrations in the legacy map. */
export function builtinTools() { return [...BUILTIN_TOOLS] }

/** Sources contributed by user-configured extensions. */
const EXTENSION_SOURCES = [/^plugin:/, /^connector:/, /^custom:/, /^mcp:/]

/**
 * Every tool a run may be granted: reviewed built-ins plus the user's enabled
 * plugins, connectors, custom webhook tools and connected MCP servers.
 * Authority is still server-issued per run (see runAuthorization).
 */
export function availableTools() {
  const extras = toolRegistry
    .list()
    .filter((t) => t.source && EXTENSION_SOURCES.some((re) => re.test(t.source!)))
  return [...builtinTools(), ...extras]
}

export async function initAgent() {
  registerBuiltinTools()
  // User-configured extensions. Each registry reads the JSON config store and
  // (re)registers the tools it owns; failures are isolated per entry.
  try { customToolRegistry.init() } catch (err) { console.error('custom tool init error:', (err as Error)?.message) }
  try { connectorRegistry.init() } catch (err) { console.error('connector init error:', (err as Error)?.message) }
  try { pluginRegistry.init() } catch (err) { console.error('plugin init error:', (err as Error)?.message) }
  try { await mcpRegistry.init() } catch (err) { console.error('mcp init error:', (err as Error)?.message) }
  console.log(`🧰 Agent ready — ${toolRegistry.list().length} tools registered`)
}

export { toolRegistry }
