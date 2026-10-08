/**
 * Agent bootstrap: register reviewed built-ins and load shared extension
 * sources (operator plugins, MCP servers). Per-user extensions are resolved by
 * availableTools(userId). Call initAgent() once at server startup.
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
import { BUILTIN_TOOL_NAMES } from './reservedNames'
import type { ToolDefinition } from './types'

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

function extensionToolsFor(userId: string): ToolDefinition[] {
  const sources: Array<[string, () => ToolDefinition[]]> = [
    ['custom tools', () => customToolRegistry.toolsFor(userId)],
    ['connectors', () => connectorRegistry.toolsFor(userId)],
    ['plugins', () => pluginRegistry.toolsFor(userId)],
    ['mcp', () => mcpRegistry.toolsFor(userId)],
  ]
  const out: ToolDefinition[] = []
  for (const [label, load] of sources) {
    try { out.push(...load()) } catch (err) { console.error(`${label} load error:`, (err as Error)?.message) }
  }
  return out
}

/**
 * Every tool a run may be granted: reviewed built-ins plus the extensions owned
 * by (or shared with) `userId`. Without a user only built-ins are offered.
 * Built-ins always win a name collision; later duplicates are dropped so no
 * extension can shadow another tool. Authority is still server-issued per run
 * (see runAuthorization).
 */
export function availableTools(userId?: string): ToolDefinition[] {
  const builtins = builtinTools()
  if (!userId) return builtins
  const names = new Set(builtins.map((t) => t.name))
  const out = [...builtins]
  for (const tool of extensionToolsFor(userId)) {
    if (names.has(tool.name) || BUILTIN_TOOL_NAMES.has(tool.name)) continue
    names.add(tool.name)
    out.push(tool)
  }
  return out
}

export async function initAgent() {
  registerBuiltinTools()
  // Shared operator plugins and MCP connections are loaded once; per-user
  // custom tools and connectors are built from the config store per run.
  try { pluginRegistry.init() } catch (err) { console.error('plugin init error:', (err as Error)?.message) }
  try { await mcpRegistry.init() } catch (err) { console.error('mcp init error:', (err as Error)?.message) }
  console.log(`🧰 Agent ready — ${toolRegistry.list().length} built-in tools registered`)
}

export { toolRegistry }
