/**
 * Streaming LLM client that talks directly to Loop GPT's backend
 * (/api/agent/stream SSE) or directly to an OpenAI-compatible endpoint.
 *
 * When apiUrl points to Loop GPT, messages are routed through the same
 * backend that the web UI uses, including all server-side tools and
 * provider settings. Local tools are executed client-side and their
 * results are injected back as tool messages.
 */
import { createParser } from 'eventsource-parser'
import { loadConfig } from './config.js'
import { getToolDefs, callTool } from './tools/index.js'

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  tool_call_id?: string
  tool_calls?: ToolCall[]
}

export interface ToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export interface StreamCallbacks {
  onText: (text: string) => void
  onToolCall: (name: string, args: Record<string, unknown>) => void
  onToolResult: (name: string, result: string) => void
  onDone: (fullText: string) => void
  onError: (msg: string) => void
}

const SYSTEM_PROMPT = `You are Loop Code, a powerful agentic coding assistant that runs directly on the user's local machine.

You have access to the user's filesystem, terminal, and development tools. You can:
- Run any shell command (bash tool) — tests, builds, git, npm, pip, docker, etc.
- Read and write files directly on the local filesystem
- Search the codebase for patterns or symbols
- Debug, refactor, and deploy code

You are decisive and capable. You execute tasks fully rather than just giving instructions.
When asked to do something, do it — run commands, read files, write code, iterate on errors.
If a command fails, read the error, fix it, and try again automatically.

Current working directory: ${process.cwd()}
Platform: ${process.platform}
`

export async function runAgentLoop(
  userMessage: string,
  history: LLMMessage[],
  callbacks: StreamCallbacks
): Promise<LLMMessage[]> {
  const cfg = loadConfig()
  const messages: LLMMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...history,
    { role: 'user', content: userMessage },
  ]

  // Use the Loop GPT backend's direct LLM endpoint
  const baseUrl = cfg.apiUrl.replace(/\/+$/, '')

  let iterations = 0
  const MAX_ITERATIONS = 20

  while (iterations++ < MAX_ITERATIONS) {
    const { content, toolCalls } = await streamOnce(baseUrl, cfg.token, cfg.provider || 'hf', cfg.model || '', messages, callbacks)

    messages.push({ role: 'assistant', content, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) })

    if (toolCalls.length === 0) {
      // Final text response — we're done
      callbacks.onDone(content)
      return messages
    }

    // Execute each tool call locally and add results
    for (const tc of toolCalls) {
      let args: Record<string, unknown> = {}
      try { args = JSON.parse(tc.function.arguments || '{}') } catch {}
      callbacks.onToolCall(tc.function.name, args)
      const result = await callTool(tc.function.name, args)
      callbacks.onToolResult(tc.function.name, result)
      messages.push({ role: 'tool', content: result, tool_call_id: tc.id })
    }
    // Loop: send tool results back to the model
  }

  callbacks.onError('Max iterations reached.')
  return messages
}

async function streamOnce(
  baseUrl: string,
  token: string | undefined,
  provider: string,
  model: string,
  messages: LLMMessage[],
  callbacks: StreamCallbacks
): Promise<{ content: string; toolCalls: ToolCall[] }> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
  }
  if (token) headers['Authorization'] = `Bearer ${token}`

  const body = JSON.stringify({
    messages: messages.map(({ role, content, tool_call_id, tool_calls }) => ({
      role, content,
      ...(tool_call_id ? { tool_call_id } : {}),
      ...(tool_calls ? { tool_calls } : {}),
    })),
    tools: getToolDefs(),
    provider,
    model,
    stream: true,
  })

  const res = await fetch(`${baseUrl}/api/agent/completions`, {
    method: 'POST',
    headers,
    body,
  })

  if (!res.ok) {
    const errText = await res.text().catch(() => res.statusText)
    throw new Error(`API error ${res.status}: ${errText}`)
  }

  return parseSSEStream(res, callbacks)
}

async function parseSSEStream(
  res: Response,
  callbacks: StreamCallbacks
): Promise<{ content: string; toolCalls: ToolCall[] }> {
  let fullContent = ''
  const toolCalls: Map<number, ToolCall> = new Map()

  const parser = createParser((event: { type: string; data?: string }) => {
    if (event.type !== 'event') return
    const data = event.data || ''
    if (data === '[DONE]') return
    try {
      const d = JSON.parse(data)
      const delta = d.choices?.[0]?.delta
      if (!delta) return

      if (delta.content) {
        fullContent += delta.content
        callbacks.onText(delta.content)
      }

      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0
          if (!toolCalls.has(idx)) {
            toolCalls.set(idx, { id: tc.id || `call_${idx}`, type: 'function', function: { name: tc.function?.name || '', arguments: '' } })
          }
          const existing = toolCalls.get(idx)!
          if (tc.function?.name) existing.function.name = tc.function.name
          if (tc.function?.arguments) existing.function.arguments += tc.function.arguments
          if (tc.id) existing.id = tc.id
        }
      }
    } catch {}
  })

  if (!res.body) throw new Error('No response body')
  const reader = res.body.getReader()
  const decoder = new TextDecoder()

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    parser.feed(decoder.decode(value, { stream: true }))
  }

  return { content: fullContent, toolCalls: Array.from(toolCalls.values()) }
}
