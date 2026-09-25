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
  AgentEvent,
  ChatMessage,
  RunAgentOptions,
  ToolDefinition,
} from './types'
import { agentConfig } from './config'
import { assertRunAccess, grantedTools, restrictRunContext } from './runAuthorization'
import { CONFIDENTIALITY_PROMPT, sanitizeText, sanitizeMetadata, makeStreamSanitizer, guardrailsEnabled } from './guardrails'
import { storeApproval, waitForApproval, clearApproval } from './approvalStore'
import { getMemories } from './tools/remember'
import { configStore, type ToolPermission } from './configStore'

/** Resolve the effective permission: an explicit override wins; otherwise a
 * tool's own needsApproval flag applies. */
export function permissionFor(name: string, needsApproval?: boolean): ToolPermission {
  const override = configStore.getToolPermissions()[name]
  if (override) return override
  return needsApproval ? 'approval' : 'allow'
}

/**
 * The interactive approval gate ("Ask before each action" mode).
 *  - blocked always wins (handled before this) and never pauses.
 *  - autoApprove (Accept edits) disables the interactive gate entirely.
 *  - stepMode forces a pause for every tool, whatever its permission level.
 */
export function requiresInteractivePause(permission: ToolPermission, stepMode: boolean, autoApprove: boolean): boolean {
  if (autoApprove) return false
  return permission === 'approval' || stepMode
}

function audit(entry: { userId?: string; conversationId: string; tool: string; args: any; outcome: any; ms: number }) {
  try {
    configStore.appendToolAudit({
      at: new Date().toISOString(),
      userId: entry.userId || 'unknown',
      conversationId: entry.conversationId,
      tool: entry.tool,
      args: JSON.stringify(entry.args ?? {}).slice(0, 500),
      outcome: entry.outcome,
      ms: Math.round(entry.ms),
    })
  } catch { /* audit is best-effort */ }
}

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

function coerceCall(raw: string, includeUnknown = false): { name: string; args: Record<string, any> } | null {
  try {
    const obj = JSON.parse(raw.trim())
    const name = obj.tool || obj.tool_name || obj.name || obj.action
    const argumentKey = ['arguments', 'args', 'parameters', 'input'].find((key) => Object.prototype.hasOwnProperty.call(obj, key))
    const args = argumentKey === undefined ? {} : obj[argumentKey]
    if (name && typeof name === 'string' && (includeUnknown || toolRegistry.has(name))) {
      return { name, args }
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
export function parseInlineToolCalls(content: string, includeUnknown = false): Array<{ name: string; args: Record<string, any> }> {
  if (!content) return []
  const calls: Array<{ name: string; args: Record<string, any> }> = []
  const add = (raw: string) => { const c = coerceCall(raw, includeUnknown); if (c) calls.push(c) }

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
export async function runAgent(opts: RunAgentOptions & { beforeDispatch?: () => Promise<void> }): Promise<RunAgentResult> {
  const {
    provider,
    apiKey,
    baseUrl,
    maxSteps = agentConfig.maxSteps,
    systemPrompt,
    toolNames,
  } = opts
  const autoApprove = opts.autoApprove === true
  const stepMode = opts.stepMode === true

  const ctx = restrictRunContext(opts.ctx, toolNames)
  await assertRunAccess(ctx)
  const model = resolveModel(provider, opts.model)
  const tools = grantedTools(ctx)
  const hasTools = tools.length > 0

  // Providers that aren't OpenAI-compatible (e.g. Anthropic native): use the
  // simple non-streaming path with no tools.
  if (!isOpenAICompatible(provider)) {
    ctx.emit({ type: 'status', message: `Querying ${provider}…` })
    await opts.beforeDispatch?.()
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
  // Qwen 3: append /no_think unless QWEN_THINKING=true (controls CoT budget).
  // A per-run thinking override (audit §8-26) wins over the env default:
  // explicit on → /think, explicit off → /no_think.
  const qwenSuffix = opts.thinking === true
    ? '/think'
    : opts.thinking === false
      ? '/no_think'
      : process.env.QWEN_THINKING === 'true' ? '/think' : (process.env.QWEN_THINKING === undefined ? '/no_think' : '')
  const working: ChatMessage[] = []
  const sys = [
    preamble,
    systemPrompt,
    opts.style,
    guardrailsEnabled ? CONFIDENTIALITY_PROMPT : '',
    hasTools ? buildToolGuide(tools) : '',
    qwenSuffix,
  ]
    .filter(Boolean)
    .join('\n\n')
  if (sys) working.push({ role: 'system', content: sys })

  // Inject user memories before the conversation messages (skipped for
  // incognito runs — they must not read from or feed into memory).
  const memories = opts.ctx?.userId && opts.useMemory !== false ? await getMemories(opts.ctx.userId) : []
  if (memories.length > 0) {
    working.push({ role: 'user', content: `[Memories]\n${memories.join('\n')}\n\n(Use the "remember" tool to save new information.)` })
  }

  working.push(...opts.messages)

  const openaiTools = hasTools ? tools.map((tool) => ({ type: 'function' as const,
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  })) : undefined
  const steps: RunAgentResult['steps'] = []
  const toolsUsed = new Set<string>()

  let stepIndex = 0
  let finalContent = ''

  ctx.emit({ type: 'warming', message: 'Contacting model (may take a moment on cold start)…' })

  for (let iter = 0; iter < maxSteps; iter++) {
    await assertRunAccess(ctx)
    const useNative = hasTools && nativeToolSupport.get(cfgKey) !== false

    // Sanitize streamed deltas (hold-back buffer catches cross-chunk identifiers).
    const sanitizer = makeStreamSanitizer((text) => ctx.emit({ type: 'delta', step: stepIndex, text }))
    let turn
    // Outside transport fallback: accounting failures must never trigger inference.
    await opts.beforeDispatch?.()
    try {
      turn = await streamTurn({
        client,
        model,
        messages: working,
        tools: useNative ? openaiTools : undefined,
        signal: ctx.signal,
        onDelta: (text) => sanitizer.push(text),
        onReasoning: (text) => ctx.emit({ type: 'thinking', step: stepIndex, text }),
        onWarming: (message) => ctx.emit({ type: 'warming', message }),
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
        try { args = c.arguments ? JSON.parse(c.arguments) : {} } catch { args = null as any }
        return { id: c.id, name: c.name, args }
      })
    } else if (hasTools) {
      calls = parseInlineToolCalls(turn.content, true)
    }
    calls = calls.filter((c) => typeof c.name === 'string' && c.name.length > 0).slice(0, MAX_CALLS_PER_TURN)

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
      ctx.emit({ type: 'tool_call', step: stepIndex, name: call.name, args: call.args, source: tools.find((tool) => tool.name === call.name)?.source })

      // Approval gate: if the tool requires approval and hasn't been
      // pre-approved, emit a pending_approval event and wait for the user
      // to respond via POST /api/agent/:conversationId/approve.
      const toolDef = toolRegistry.get(call.name)
      const permission = permissionFor(call.name, toolDef?.needsApproval)

      // Blocked: never execute; tell the model and record it.
      if (permission === 'blocked') {
        const blocked = { content: `Tool "${call.name}" is blocked by user settings.`, isError: true }
        ctx.emit({ type: 'tool_result', step: stepIndex, name: call.name, content: blocked.content, isError: true })
        steps.push({ tool: call.name, args: call.args, result: blocked.content })
        audit({ userId: ctx.userId, conversationId: ctx.conversationId, tool: call.name, args: call.args, outcome: 'blocked', ms: 0 })
        if (native) working.push({ role: 'tool', tool_call_id: call.id, name: call.name, content: blocked.content })
        else inlineResults.push(`TOOL_RESULT (${call.name}):\n${blocked.content}`)
        stepIndex++
        continue
      }

      // "Ask before each action": every tool pauses for approval (except when
      // auto-approve is on, which disables the interactive gate entirely).
      if (requiresInteractivePause(permission, stepMode, autoApprove)) {
        storeApproval(ctx.conversationId, call.name, call.args)
        ctx.emit({ type: 'pending_approval', tool_name: call.name, args: call.args, prompt: `Approve "${call.name}" with the provided arguments?` })
        const approved = await waitForApproval(ctx.conversationId, call.name)
        if (!approved) {
          const denialResult = { content: `Tool "${call.name}" was not approved by the user.`, isError: true }
          ctx.emit({ type: 'tool_result', step: stepIndex, name: call.name, content: denialResult.content, isError: true })
          steps.push({ tool: call.name, args: call.args, result: denialResult.content })
          audit({ userId: ctx.userId, conversationId: ctx.conversationId, tool: call.name, args: call.args, outcome: 'denied', ms: 0 })
          if (native) {
            working.push({ role: 'tool', tool_call_id: call.id, name: call.name, content: denialResult.content })
          } else {
            inlineResults.push(`TOOL_RESULT (${call.name}):\n${denialResult.content}`)
          }
          stepIndex++
          continue
        }
        audit({ userId: ctx.userId, conversationId: ctx.conversationId, tool: call.name, args: call.args, outcome: 'approved', ms: 0 })
      }

      const startedAt = Date.now()
      // Step-scoped emit (audit §8-28/29): temporarily wrap emit on the SAME
      // context object — the run grant is keyed to ctx identity in a WeakMap
      // (spreading would orphan it, failing assertRunAccess) — so
      // tool_output/progress events emitted by the tool get stamped with the
      // executing step. Tool execution is sequential in this loop; the
      // finally restores the original emit before the loop continues.
      const scopedEmit = ctx.emit
      ctx.emit = (event: AgentEvent) => {
        if (event.type === 'tool_output' || event.type === 'progress') {
          scopedEmit({ ...event, step: stepIndex } as AgentEvent)
        } else {
          scopedEmit(event)
        }
      }
      let result: Awaited<ReturnType<typeof toolRegistry.execute>>
      try {
        result = await toolRegistry.execute(call.name, call.args, ctx)
      } finally {
        ctx.emit = scopedEmit
      }
      audit({ userId: ctx.userId, conversationId: ctx.conversationId, tool: call.name, args: call.args,
        outcome: result.isError ? 'error' : 'ok', ms: Date.now() - startedAt })
      if (!result.isError) toolsUsed.add(call.name)
      ctx.emit({ type: 'tool_result', step: stepIndex, name: call.name, content: truncate(result.content, 4000), data: result.data, isError: result.isError })
      // Per-step artifact attribution (audit §8-28): names only — the full
      // refs already live in metadata.artifacts; this lets a stored step
      // card link "View in panel" to the artifact it produced.
      const stepArtifacts = Array.isArray(result.data?.artifacts) ? result.data.artifacts.map((a: any) => a.name) : undefined
      steps.push({ tool: call.name, args: call.args, result: truncate(result.content, 2000), ...(stepArtifacts ? { artifacts: stepArtifacts } : {}) })

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
