/**
 * The agent runtime: a streaming tool-calling loop.
 *
 * Robustness strategy for an unknown llama.cpp deployment:
 *  - We ALWAYS inject a compact JSON tool protocol into the system prompt, so a
 *    model that ignores the OpenAI "tools" channel can still call tools by
 *    emitting an inline JSON object (ReAct-style).
 *  - We ALSO pass native `tools` to the API (best effort). If that request
 *    errors (e.g. server started without --jinja), we cache that the endpoint
 *    lacks native tool support and continue in inline-JSON mode.
 *  - Each turn we look for a tool call in BOTH `message.tool_calls` and the
 *    inline JSON — whichever appears.
 */
import type { AIProvider } from '../services/aiProviders'
import { toolRegistry } from './toolRegistry'
import {
  createClient,
  resolveModel,
  streamTurn,
  isOpenAICompatible,
} from './llmClient'
import { aiProviderService } from '../services/aiProviders'
import type {
  ChatMessage,
  RunAgentOptions,
  ToolDefinition,
} from './types'
import { agentConfig } from './config'
import { CONFIDENTIALITY_PROMPT, sanitizeText, sanitizeMetadata, makeStreamSanitizer, guardrailsEnabled } from './guardrails'

/** Per-baseURL memo of whether native tool-calling works. */
const nativeToolSupport = new Map<string, boolean>()

export interface RunAgentResult {
  content: string
  steps: Array<{ tool?: string; args?: any; result?: string }>
  toolsUsed: string[]
}

function buildToolGuide(tools: ToolDefinition[]): string {
  const lines = tools.map((t) => {
    const params = JSON.stringify(t.parameters?.properties || {})
    return `- ${t.name}: ${t.description} | arguments: ${params}`
  })
  return [
    'You have access to the following tools:',
    ...lines,
    '',
    'To use a tool, reply with ONLY a JSON object and nothing else:',
    '{"tool": "<tool_name>", "arguments": { ... }}',
    'You will then receive a message starting with "TOOL_RESULT". Use it to decide your next step.',
    'You may call tools multiple times in sequence. When you have enough information,',
    'reply to the user in normal prose (no JSON). Never fabricate tool results.',
  ].join('\n')
}

/** Extract all top-level balanced {...} JSON object substrings from text. */
function extractBalancedObjects(s: string): string[] {
  const out: string[] = []
  let depth = 0
  let start = -1
  let inStr = false
  let esc = false
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (inStr) {
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') inStr = true
    else if (c === '{') { if (depth === 0) start = i; depth++ }
    else if (c === '}') { depth--; if (depth === 0 && start >= 0) { out.push(s.slice(start, i + 1)); start = -1 } }
  }
  return out
}

function coerceCall(raw: string): { name: string; args: Record<string, any> } | null {
  try {
    const obj = JSON.parse(raw.trim())
    const name = obj.tool || obj.tool_name || obj.name || obj.action
    const args = obj.arguments || obj.args || obj.parameters || obj.input || {}
    if (name && typeof name === 'string' && toolRegistry.has(name)) {
      return { name, args: typeof args === 'object' && args ? args : {} }
    }
  } catch {
    /* not valid JSON */
  }
  return null
}

/**
 * Extract ALL inline tool calls from a model turn. Handles the common formats a
 * llama.cpp / Qwen / Hermes model emits: <tool_call>{...}</tool_call> blocks,
 * fenced ```json blocks, and bare balanced {...} objects — including MULTIPLE
 * calls in a single turn.
 */
export function parseInlineToolCalls(content: string): Array<{ name: string; args: Record<string, any> }> {
  if (!content) return []
  const calls: Array<{ name: string; args: Record<string, any> }> = []
  const add = (raw: string) => { const c = coerceCall(raw); if (c) calls.push(c) }

  // 1. <tool_call>...</tool_call> (and <tool_code>) tagged blocks.
  const tagRe = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi
  let m: RegExpExecArray | null
  while ((m = tagRe.exec(content))) add(m[1])
  if (calls.length) return calls

  // 2. Fenced ```json blocks.
  const fenceRe = /```(?:json|tool_call)?\s*([\s\S]*?)```/gi
  while ((m = fenceRe.exec(content))) add(m[1])
  if (calls.length) return calls

  // 3. Bare balanced {...} objects (handles multiple).
  for (const obj of extractBalancedObjects(content)) add(obj)
  return calls
}

/** Backwards-compatible single-call helper. */
export function parseInlineToolCall(content: string): { name: string; args: Record<string, any> } | null {
  return parseInlineToolCalls(content)[0] || null
}

/**
 * Run the agent loop, streaming events through ctx.emit. Returns the final
 * answer and a trace of the steps taken.
 */
export async function runAgent(opts: RunAgentOptions): Promise<RunAgentResult> {
  const {
    provider,
    apiKey,
    baseUrl,
    ctx,
    maxSteps = agentConfig.maxSteps,
    systemPrompt,
    toolNames,
  } = opts

  const model = resolveModel(provider, opts.model)
  const tools = toolRegistry.resolve(toolNames)
  const hasTools = tools.length > 0

  // Providers that aren't OpenAI-compatible (e.g. Anthropic native): use the
  // simple non-streaming path with no tools.
  if (!isOpenAICompatible(provider)) {
    ctx.emit({ type: 'status', message: `Querying ${provider}…` })
    const text = await aiProviderService.getChatCompletion(
      provider,
      opts.messages.map((m) => ({ role: m.role, content: contentToString(m.content) })),
      model,
      apiKey,
      baseUrl
    )
    ctx.emit({ type: 'delta', step: 0, text })
    ctx.emit({ type: 'final', content: text })
    return { content: text, steps: [], toolsUsed: [] }
  }

  const client = createClient(provider, apiKey, baseUrl)
  const cfgKey = `${provider}:${baseUrl || process.env.HF_ENDPOINT_URL || ''}`

  // Assemble the working message list with system prompt + tool guide.
  // Order: system prompt first (highest weight for most models), then
  // confidentiality rules, then tool guide. An UNRESTRICTED_PREAMBLE can be
  // injected via env to help uncensored models stay on-task.
  const preamble = process.env.UNRESTRICTED_PREAMBLE || ''
  // Qwen 3: append /no_think unless QWEN_THINKING=true (controls CoT budget)
  const qwenSuffix = process.env.QWEN_THINKING === 'true' ? '/think' : (process.env.QWEN_THINKING === undefined ? '/no_think' : '')
  const working: ChatMessage[] = []
  const sys = [
    preamble,
    systemPrompt,
    guardrailsEnabled ? CONFIDENTIALITY_PROMPT : '',
    hasTools ? buildToolGuide(tools) : '',
    qwenSuffix,
  ]
    .filter(Boolean)
    .join('\n\n')
  if (sys) working.push({ role: 'system', content: sys })
  working.push(...opts.messages)

  const openaiTools = hasTools ? toolRegistry.toOpenAITools(toolNames) : undefined
  const steps: RunAgentResult['steps'] = []
  const toolsUsed = new Set<string>()

  let stepIndex = 0
  let finalContent = ''

  ctx.emit({ type: 'warming', message: 'Contacting model (may take a moment on cold start)…' })

  for (let iter = 0; iter < maxSteps; iter++) {
    const useNative = hasTools && nativeToolSupport.get(cfgKey) !== false

    // Sanitize streamed deltas (hold-back buffer catches cross-chunk identifiers).
    const sanitizer = makeStreamSanitizer((text) => ctx.emit({ type: 'delta', step: stepIndex, text }))
    let turn
    try {
      turn = await streamTurn({
        client,
        model,
        messages: working,
        tools: useNative ? openaiTools : undefined,
        signal: ctx.signal,
        onDelta: (text) => sanitizer.push(text),
      })
      sanitizer.flush()
    } catch (err: any) {
      sanitizer.flush()
      // If native tool params likely caused the failure, disable and retry.
      if (useNative && nativeToolSupport.get(cfgKey) === undefined) {
        nativeToolSupport.set(cfgKey, false)
        iter--
        continue
      }
      throw err
    }

    // A successful native-tools request confirms support.
    if (useNative && nativeToolSupport.get(cfgKey) === undefined) {
      nativeToolSupport.set(cfgKey, true)
    }

    // Determine which tool(s) were requested — native array first, else inline.
    // A single turn may request MULTIPLE tools; we execute them all.
    const MAX_CALLS_PER_TURN = 8
    let calls: Array<{ id?: string; name: string; args: Record<string, any> }> = []
    const native = turn.toolCalls.length > 0

    if (native) {
      calls = turn.toolCalls.map((c) => {
        let args: Record<string, any> = {}
        try { args = c.arguments ? JSON.parse(c.arguments) : {} } catch { args = {} }
        return { id: c.id, name: c.name, args }
      })
    } else if (hasTools) {
      calls = parseInlineToolCalls(turn.content)
    }
    calls = calls.filter((c) => c.name && toolRegistry.has(c.name)).slice(0, MAX_CALLS_PER_TURN)

    if (calls.length === 0) {
      // No tool requested → this is the final answer.
      finalContent = sanitizeText(turn.content)
      break
    }

    // Record the assistant turn (with native tool_calls when applicable).
    if (native) {
      working.push({
        role: 'assistant',
        content: turn.content || '',
        // @ts-expect-error tool_calls is valid on assistant messages
        tool_calls: calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } })),
      })
    } else {
      working.push({ role: 'assistant', content: turn.content })
    }

    // Execute every requested tool (the first reuses this turn's step index so
    // the UI replaces any streamed tool-call text with a tool card).
    const inlineResults: string[] = []
    for (const call of calls) {
      ctx.emit({ type: 'tool_call', step: stepIndex, name: call.name, args: call.args, source: toolRegistry.get(call.name)?.source })
      toolsUsed.add(call.name)
      const result = await toolRegistry.execute(call.name, call.args, ctx)
      ctx.emit({ type: 'tool_result', step: stepIndex, name: call.name, content: truncate(result.content, 4000), data: result.data, isError: result.isError })
      steps.push({ tool: call.name, args: call.args, result: truncate(result.content, 2000) })

      if (native) {
        working.push({ role: 'tool', tool_call_id: call.id, name: call.name, content: result.content })
      } else {
        inlineResults.push(`TOOL_RESULT (${call.name}):\n${result.content}`)
      }
      stepIndex++
    }
    if (!native) working.push({ role: 'user', content: inlineResults.join('\n\n') })
  }

  if (!finalContent) {
    finalContent = sanitizeText('I reached the maximum number of reasoning steps. Here is what I have so far:\n\n' +
      steps.map((s) => `- ${s.tool}: ${s.result || ''}`).join('\n'))
  }

  ctx.emit({ type: 'final', content: finalContent, metadata: sanitizeMetadata({ toolsUsed: Array.from(toolsUsed), steps }) })
  return { content: finalContent, steps, toolsUsed: Array.from(toolsUsed) }
}

function contentToString(content: ChatMessage['content']): string {
  if (typeof content === 'string') return content
  return content
    .map((p) => (p.type === 'text' ? p.text : '[image]'))
    .join('\n')
}

function truncate(s: string, max: number): string {
  if (!s) return ''
  return s.length > max ? s.slice(0, max) + `\n…[truncated ${s.length - max} chars]` : s
}
