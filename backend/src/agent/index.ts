/**
 * Agent bootstrap: register reviewed built-ins only. Legacy shared extensions
 * are not initialized. Call initAgent() once at server startup.
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
import { speakTool } from './tools/speakText'
import { ocrTool } from './tools/ocr'

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
  searchKnowledgeTool,
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

export async function initAgent() {
  registerBuiltinTools()
  // Do not load legacy shared credentials, plugins, commands or custom tools.
  // Reviewed workspace adapters must be issued as per-run capabilities instead.
  console.log(`🧰 Agent ready — ${toolRegistry.list().length} tools registered`)
}

export { toolRegistry }
