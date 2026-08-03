/**
 * Thin wrapper over the OpenAI SDK that targets any OpenAI-compatible provider,
 * with the Hugging Face Inference Endpoint as the primary backend.
 *
 * Provides streaming chat with optional native tool-calling. Providers that are
 * not OpenAI-compatible (e.g. Anthropic's native API) are handled by falling
 * back to the non-streaming aiProviderService elsewhere.
 */
import OpenAI from 'openai'
import type { AIProvider } from '../services/aiProviders'
import { getHFBaseUrl, getHFModel } from '../services/aiProviders'
import type { ChatMessage } from './types'
import { agentConfig } from './config'

export interface OpenAITargetConfig {
  baseURL?: string
  apiKey: string
}

/** Providers we can drive through the OpenAI SDK (chat + streaming + tools). */
export function isOpenAICompatible(provider: AIProvider): boolean {
  return [
    'huggingface',
    'openai',
    'groq',
    'together',
    'nvidia',
    'xai',
    'perplexity',
    'local',
    'ollama',
  ].includes(provider)
}

export function resolveOpenAIConfig(
  provider: AIProvider,
  apiKey?: string,
  baseUrl?: string
): OpenAITargetConfig {
  const env = process.env
  switch (provider) {
    case 'huggingface':
      return { baseURL: getHFBaseUrl(baseUrl), apiKey: apiKey || env.HF_TOKEN || 'sk-no-key' }
    case 'openai':
      return { baseURL: baseUrl, apiKey: apiKey || env.OPENAI_API_KEY || '' }
    case 'groq':
      return { baseURL: 'https://api.groq.com/openai/v1', apiKey: apiKey || env.GROQ_API_KEY || '' }
    case 'together':
      return { baseURL: 'https://api.together.xyz/v1', apiKey: apiKey || env.TOGETHER_API_KEY || '' }
    case 'nvidia':
      return { baseURL: baseUrl || 'https://integrate.api.nvidia.com/v1', apiKey: apiKey || env.NVIDIA_API_KEY || '' }
    case 'xai':
      return { baseURL: 'https://api.x.ai/v1', apiKey: apiKey || env.XAI_API_KEY || '' }
    case 'perplexity':
      return { baseURL: 'https://api.perplexity.ai', apiKey: apiKey || env.PERPLEXITY_API_KEY || '' }
    case 'ollama':
      return { baseURL: (baseUrl || 'http://localhost:11434') + '/v1', apiKey: 'ollama' }
    case 'local':
      return { baseURL: baseUrl || 'http://localhost:1234/v1', apiKey: apiKey || 'local' }
    default:
      return { baseURL: baseUrl, apiKey: apiKey || '' }
  }
}

export function createClient(provider: AIProvider, apiKey?: string, baseUrl?: string): OpenAI {
  const cfg = resolveOpenAIConfig(provider, apiKey, baseUrl)
  return new OpenAI({
    apiKey: cfg.apiKey || 'sk-no-key',
    baseURL: cfg.baseURL,
    timeout: agentConfig.requestTimeoutMs, // tolerate cold starts + long generations
    maxRetries: 0,
  })
}

export function resolveModel(provider: AIProvider, model?: string): string {
  if (provider === 'huggingface') return getHFModel(model)
  return model || 'gpt-3.5-turbo'
}

/** Accumulated result of one streamed model turn. */
export interface StreamTurnResult {
  content: string
  toolCalls: Array<{ id: string; name: string; arguments: string }>
  finishReason: string | null
}

export interface StreamTurnOptions {
  client: OpenAI
  model: string
  messages: ChatMessage[]
  tools?: OpenAI.Chat.Completions.ChatCompletionTool[]
  temperature?: number
  maxTokens?: number
  signal?: AbortSignal
  /** Called for every text delta as it streams in. */
  onDelta?: (text: string) => void
}

/**
 * Run one streaming chat turn, accumulating text and (native) tool calls.
 * Throws on API errors so the caller can decide on a fallback.
 */
export async function streamTurn(opts: StreamTurnOptions): Promise<StreamTurnResult> {
  const { client, model, messages, tools, onDelta, signal } = opts

  const params: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming = {
    model,
    messages: messages as any,
    temperature: opts.temperature ?? agentConfig.temperature,
    max_tokens: opts.maxTokens ?? agentConfig.maxTokens,
    stream: true,
  } as any

  // Qwen 3 thinking mode: set QWEN_THINKING=true to enable chain-of-thought
  // (slower but better for hard reasoning). Default: disabled (faster).
  if (process.env.QWEN_THINKING !== 'true') {
    ;(params as any).enable_thinking = false
  }

  if (tools && tools.length > 0) {
    params.tools = tools as any
    params.tool_choice = 'auto'
  }

  const stream = await client.chat.completions.create(params, { signal })

  let content = ''
  const toolCallsAcc: Array<{ id: string; name: string; arguments: string }> = []
  let finishReason: string | null = null

  for await (const chunk of stream) {
    const choice = chunk.choices?.[0]
    if (!choice) continue
    const delta = choice.delta as any
    if (delta?.content) {
      content += delta.content
      onDelta?.(delta.content)
    }
    if (delta?.tool_calls) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index ?? 0
        if (!toolCallsAcc[idx]) {
          toolCallsAcc[idx] = { id: tc.id || `call_${idx}`, name: '', arguments: '' }
        }
        if (tc.id) toolCallsAcc[idx].id = tc.id
        if (tc.function?.name) toolCallsAcc[idx].name += tc.function.name
        if (tc.function?.arguments) toolCallsAcc[idx].arguments += tc.function.arguments
      }
    }
    if (choice.finish_reason) finishReason = choice.finish_reason
  }

  return { content, toolCalls: toolCallsAcc.filter(Boolean), finishReason }
}

/** Non-streaming single call (used for internal sub-agent steps). */
export async function completeOnce(
  client: OpenAI,
  model: string,
  messages: ChatMessage[],
  temperature = 0.5,
  maxTokens = 2000
): Promise<string> {
  const completion = await client.chat.completions.create({
    model,
    messages: messages as any,
    temperature,
    max_tokens: maxTokens,
  })
  return completion.choices[0]?.message?.content || ''
}
