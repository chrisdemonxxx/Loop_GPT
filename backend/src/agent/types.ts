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
  /** Identity only; execution authority is held server-side, not in this field. */
  workspaceId?: string
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
  /** When true, the tool requires the user to approve execution mid‑stream.
   * The agent loop emits a `pending_approval` event and pauses until the
   * user submits a decision via POST /api/agent/:conversationId/approve. */
  needsApproval?: boolean
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
  | { type: 'run'; runId: string }
  | { type: 'warming'; message: string }
  | { type: 'delta'; step: number; text: string }
  | { type: 'thinking'; step: number; text: string }
  | { type: 'tool_call'; step: number; name: string; args: Record<string, any>; source?: string }
  /** Live tool output while a tool runs (audit §8-28): e.g. execute_code
   *  stdout/stderr streamed as it is produced instead of at completion.
   *  Tools emit WITHOUT step; the runtime stamps the executing step, so
   *  everything the client receives carries one. */
  | { type: 'tool_output'; step?: number; chunk: string; stream?: 'stdout' | 'stderr' }
  /** General to-do/progress checklist for a running step (audit §8-29):
   *  sub-agent tasks, multi-phase tools. The latest event per step wins.
   *  Tools emit WITHOUT step; the runtime stamps the executing step. */
  | { type: 'progress'; step?: number; items: Array<{ id: string; label: string; status: 'pending' | 'active' | 'done' | 'error' }> }
  | { type: 'tool_result'; step: number; name: string; content: string; data?: any; isError?: boolean }
  | { type: 'artifact'; artifact: ArtifactRef }
  | { type: 'pending_approval'; tool_name: string; args: Record<string, any>; prompt: string }
  | { type: 'final'; content: string; metadata?: any }
  | { type: 'error'; message: string }
  | { type: 'done' }

export interface ArtifactRef {
  id: string
  kind: 'image' | 'video' | 'pdf' | 'docx' | 'xlsx' | 'pptx' | 'csv' | 'file'
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
    /** Optional style preset (system prompt snippet from UserStyle). */
    style?: string
    /**
     * When true (the "Accept edits" run mode), tools that would normally pause
     * for approval run without pausing. The per-tool 'blocked' permission still
     * applies; this only auto-approves the interactive gate.
     */
    autoApprove?: boolean
    /**
     * "Ask before each action" run mode: every tool call pauses for approval,
     * regardless of its configured permission level. 'blocked' still wins;
     * autoApprove disables the gate entirely.
     */
    stepMode?: boolean
    /** Incognito: skip memory injection and block the remember tool. */
    useMemory?: boolean
    /**
     * Extended-thinking override (audit §8-26): per-run CoT switch for
     * thinking-capable models. `true` forces thinking on (e.g. Qwen /think),
     * `false` forces it off (/no_think); omitted keeps the operator env
     * default (QWEN_THINKING).
     */
    thinking?: boolean
  }
