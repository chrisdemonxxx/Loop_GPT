/**
 * Shared types for the agent runtime.
 */
import type { AIProvider } from '../services/aiProviders'

/** OpenAI-style content part for multimodal (vision) messages. */
export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | ContentPart[]
  /** Present on tool-result messages when using native tool calling. */
  tool_call_id?: string
  name?: string
}

/** JSON-schema-ish parameter definition for a tool. */
export interface ToolParameterSchema {
  type: string
  properties?: Record<string, any>
  required?: string[]
  [key: string]: any
}

export interface ToolContext {
  userId: string
  conversationId: string
  /** Emit a progress event to the client (SSE). */
  emit: (event: AgentEvent) => void
  /** Signal used to abort long-running work. */
  signal?: AbortSignal
  /** Arbitrary per-run scratch space (e.g. collected artifacts, citations). */
  scratch: Record<string, any>
}

export interface ToolDefinition {
  name: string
  description: string
  parameters: ToolParameterSchema
  /** Source of the tool: builtin, mcp server id, skill id, plugin id. */
  source?: string
  handler: (args: Record<string, any>, ctx: ToolContext) => Promise<ToolResult>
}

export interface ToolResult {
  /** Text the model sees as the tool result. */
  content: string
  /** Optional structured payload streamed to the UI (images, files, citations). */
  data?: any
  isError?: boolean
}

/** Events streamed to the client over SSE. */
export type AgentEvent =
  | { type: 'status'; message: string }
  | { type: 'warming'; message: string }
  | { type: 'delta'; step: number; text: string }
  | { type: 'tool_call'; step: number; name: string; args: Record<string, any>; source?: string }
  | { type: 'tool_result'; step: number; name: string; content: string; data?: any; isError?: boolean }
  | { type: 'artifact'; artifact: ArtifactRef }
  | { type: 'final'; content: string; metadata?: any }
  | { type: 'error'; message: string }
  | { type: 'done' }

export interface ArtifactRef {
  id: string
  kind: 'image' | 'pdf' | 'docx' | 'xlsx' | 'pptx' | 'csv' | 'file'
  name: string
  url?: string
  mimeType?: string
}

export interface RunAgentOptions {
  messages: ChatMessage[]
  provider: AIProvider
  model: string
  apiKey?: string
  baseUrl?: string
  /** Tool names to enable for this run. Empty/omitted = plain chat, no tools. */
  toolNames?: string[]
  systemPrompt?: string
  maxSteps?: number
  ctx: ToolContext
}
