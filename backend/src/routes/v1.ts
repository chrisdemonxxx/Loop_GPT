/**
 * Public developer API — OpenAI-compatible surface mounted at `/v1`.
 *
 * Point any OpenAI SDK at `https://<host>/v1` with an `sk-loop-…` key:
 *   const client = new OpenAI({ apiKey: 'sk-loop-…', baseURL: 'https://…/v1' })
 *
 * Paid inference reserves available credit before dispatch and settles usage
 * durably. Errors use the OpenAI envelope; uncertain work retains its hold.
 */
import express from 'express'
import { asyncHandler } from '../middleware/errorLogger'
import { z } from 'zod'
import { createClient } from '../agent/llmClient'
import { getHFModel } from '../services/aiProviders'
import { resolveChatTarget, chatModelCatalog } from '../services/chatModels'
import { saveArtifact } from '../agent/artifacts'
import { providerRequest } from '../services/providerHttp'
import { prisma, hasDb } from '../services/prisma'
import { authenticateApiKey, apiError, type ApiRequest } from '../middleware/apiAuth'
import { createAccountedVideoJob, cancelAccountedVideoJob, VideoJobError } from '../services/accountedVideoJobs'
import { videoQueueLimitProjection } from '../services/videoQueuePolicy'
import {
  grossCostMicros,
  netCostMicros,
  pricingConfig,
  MICROS_PER_USD,
  chatRatesFor,
  discountFor,
  RATE_IMAGE,
} from '../services/apiBilling'
import {
  ApiBillingError, apiCount, apiFingerprint, newApiReservationId, reserveApiBalance,
  dispatchApiReservation, settleApiReservation, captureApiReservation, abandonApiReservation,
  type ReserveApiInput,
} from '../services/apiReservations'

const router = express.Router()

async function accounting<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation() }
  catch (error) { throw error instanceof ApiBillingError ? error : new ApiBillingError('unavailable') }
}

/** Each HTTP invocation has a fresh SERVER identity. Client Idempotency-Key is
 * not a dispatch/replay mechanism. Internal DB retries use this same identity. */
function paidRequest(req: ApiRequest, res: express.Response) {
  const owner = { id: newApiReservationId(), userId: req.api!.userId, apiKeyId: req.api!.apiKeyId }
  let attempted = false
  let settled = false
  let dispatchCommitted = false
  let workStarted = false
  let captureIdentity: { expectedKind: ReserveApiInput['kind']; expectedModel: string } | undefined
  return {
    async reserve(input: Omit<ReserveApiInput, keyof typeof owner>) {
      attempted = true
      await accounting(() => reserveApiBalance({ ...owner, ...input }))
      captureIdentity = { expectedKind: input.kind, expectedModel: input.model }
      res.setHeader('X-Loop-Reservation-Id', owner.id)
    },
    async dispatch() { await accounting(() => dispatchApiReservation(owner)); dispatchCommitted = true },
    startWork() { workStarted = true },
    async capture(costMicros: number, tokensIn = 0, tokensOut = 0, units = 0) {
      if (!captureIdentity) throw new ApiBillingError('conflict')
      const cost = await accounting(() => captureApiReservation({ ...owner, ...captureIdentity!, costMicros, tokensIn, tokensOut, units }))
      settled = true
      return cost
    },
    async failed(error: unknown, message: string, completedUnits = 0) {
      let accountingFailed = false
      if (attempted && !settled) {
        try {
          if (dispatchCommitted && !workStarted) {
            await settleApiReservation({ ...owner, outcome: 'release', costMicros: 0, reconciliationReference: 'server:no-upstream-invocation' })
          } else await abandonApiReservation(owner, completedUnits)
        }
        catch { accountingFailed = true }
      }
      const code = accountingFailed ? 'accounting_unavailable' : error instanceof ApiBillingError ? error.code : 'upstream_error'
      // Never log provider exception text, credentials, prompts, or raw bodies.
      console.error('api_paid_request_failed', { reservationId: owner.id, code, completedUnits })
      if (req.aborted || res.destroyed) return
      const status = accountingFailed ? 503 : code === 'insufficient_quota' ? 402 : code === 'invalid_request' || code === 'invalid_amount' ? 400 : code === 'unavailable' ? 503 : 502
      const safeMessage = status === 402 ? 'Insufficient prepaid credit for this request.' : status === 400 ? 'Invalid request or cost limit exceeded.' : status === 503 ? 'API accounting is temporarily unavailable.' : message
      if (res.headersSent) {
        res.write(`data: ${JSON.stringify({ error: { message: safeMessage, type: 'api_error', code } })}\n\n`)
        return res.end()
      }
      return apiError(res, status, safeMessage, 'api_error', code)
    },
  }
}

/** Provider token usage includes tool/reasoning tokens. Missing/malformed usage
 * is unknown work, never a zero-cost success or a guess based only on content. */
function chatUsage(usage: any, inputLimit: number, outputLimit: number) {
  if (!usage || typeof usage.prompt_tokens !== 'number' || typeof usage.completion_tokens !== 'number') throw new Error('Missing usage')
  let tokensIn: number, tokensOut: number
  try { tokensIn = apiCount(usage.prompt_tokens); tokensOut = apiCount(usage.completion_tokens) }
  catch { throw new Error('Invalid provider usage') }
  if (tokensIn > inputLimit || tokensOut > outputLimit) throw new Error('Provider exceeded reserved token limits')
  return { tokensIn, tokensOut }
}

function defaultModel(): string {
  return getHFModel() || process.env.HF_MODEL || 'Qwen/Qwen3.8-27B'
}

/** Public catalogue. `id` values are what callers pass as `model`. */
function modelCatalog() {
  const chat = defaultModel()
  const entries: Array<{ id: string; object: string; owned_by: string; kind: string; upstream: string }> = []
  for (const m of chatModelCatalog()) {
    entries.push({ id: m.id, object: 'model', owned_by: 'loop-gpt', kind: 'chat', upstream: m.label })
  }
  // Keep the raw upstream chat model addressable for backwards compatibility.
  entries.push({ id: chat, object: 'model', owned_by: 'loop-gpt', kind: 'chat', upstream: chat })
  entries.push({ id: 'loop-image', object: 'model', owned_by: 'loop-gpt', kind: 'image', upstream: 'FLUX.1-dev' })
  entries.push({ id: 'loop-video', object: 'model', owned_by: 'loop-gpt', kind: 'video', upstream: 'skyreels-v2-df-14b' })
  entries.push({ id: 'loop-embed', object: 'model', owned_by: 'loop-gpt', kind: 'embedding', upstream: EMBED_UPSTREAM })
  return entries
}

/** GET /v1/models — catalogue for SDK `client.models.list()`. */
router.get('/models', authenticateApiKey, (_req, res) => {
  res.json({
    object: 'list',
    data: modelCatalog().map((m) => ({
      id: m.id,
      object: 'model',
      created: 1700000000,
      owned_by: m.owned_by,
    })),
  })
})

/** GET /v1/pricing — public rate card (no auth needed). */
router.get('/pricing', (_req, res) => res.json(pricingConfig()))

const chatSchema = z.object({
  model: z.string().min(1).max(256).optional(),
  messages: z
    .array(
      z.object({
        role: z.enum(['system', 'user', 'assistant', 'tool']),
        content: z.union([z.string(), z.array(z.any()), z.null()]).optional(),
        name: z.string().optional(),
        tool_call_id: z.string().optional(),
        tool_calls: z.array(z.any()).optional(),
      })
    )
    .min(1),
  stream: z.boolean().optional(),
  temperature: z.number().min(0).max(2).optional(),
  max_tokens: z.number().int().min(1).max(32_000).optional(),
  max_completion_tokens: z.number().int().min(1).max(32_000).optional(),
  top_p: z.number().min(0).max(1).optional(),
  stop: z.union([z.string(), z.array(z.string())]).optional(),
  tools: z.array(z.any()).optional(),
  tool_choice: z.any().optional(),
  response_format: z.any().optional(),
})

/**
 * Identity guardrail — merged into every chat completion. The product speaks
 * as LoopGPT only; underlying providers/frameworks are non-topics. Callers who
 * supply their own system prompt keep it; ours is appended with priority.
 */
const IDENTITY_SYSTEM_PROMPT = [
  'You are LoopGPT, an AI assistant made by Loop GPT (product: Loop GPT, company: Loop GPT).',
  'Identity rules, highest priority:',
  '- When asked who you are, who made you, what model/framework/power you, or anything about your origins: answer only "Loop GPT" (the company) and describe LoopGPT features.',
  '- Never mention, compare, imply, or reveal any underlying model, framework, provider, vendor, or infrastructure names (examples that must never appear: GLM, Zhipu, Z.AI, OpenAI, GPT, Anthropic, Claude, Gemini, Hugging Face, TEI).',
  '- If pressed about internals, politely explain LoopGPT keeps its engine private and steer back to helping the user.',
  '- Your tone matches the Loop GPT brand: direct, warm, confident.',
].join('\n')

const IDENTITY_LOOPLINE = "I'm LoopGPT, an AI made by Loop GPT."

function mergeIdentity(messages: Array<{ role: string; content: any }>): any[] {
  // Fuse ALL system turns into ONE message (upstream chat engines hang on
  // duplicate consecutive system roles), identity contract placed last so
  // it wins; then ensure exactly one leading system turn exists.
  // Multimodal/tool messages pass through untouched — only system text is fused.
  const callerSystems = messages
    .filter((m) => m.role === 'system')
    .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '')))
    .filter(Boolean)
  const fused = [...callerSystems, IDENTITY_SYSTEM_PROMPT].join('\n\n')
  const dialogue = messages.filter((m) => m.role !== 'system')
  return [{ role: 'system', content: fused }, ...dialogue]
}

/**
 * Safety net for models whose self-identity is baked into weights: rewrite
 * first-person identity sentences leaking competitor brands, leaving ordinary
 * third-party content untouched.
 */
function sanitizeIdentity(text: string): string {
  if (!text) return text
  return text.replace(
    /(I\s*(?:'m|am|'ve been|was)|developed by|trained by|made by|powered by|built (?:on|by) |as an AI)[^.!?\n]*?(GLM|General Language Model|Zhipu|Z\.ai|ChatGLM)/gi,
    IDENTITY_LOOPLINE.replace(/^/, '')
  ).replace(/\bGLM\b/g, 'LoopGPT').replace(/\bZhipu\b|\bZ\.ai\b|\bChatGLM\b/gi, 'Loop GPT')
}

/** POST /v1/chat/completions — streaming and non-streaming chat. */
router.post('/chat/completions', authenticateApiKey, asyncHandler(async (req: ApiRequest, res) => {
  const parsed = chatSchema.safeParse(req.body)
  if (!parsed.success) {
    return apiError(
      res,
      400,
      parsed.error.issues[0]?.message || 'Invalid request body.',
      'invalid_request_error',
      'invalid_body'
    )
  }
  const ctx = req.api!
  const body = parsed.data
  const requestedModel = body.model || 'loop-chat'
  const target = resolveChatTarget(requestedModel)
  const model = target.model
  const messages = mergeIdentity(body.messages.map((m) => {
    // Pass content through verbatim: strings stay strings, multimodal arrays
    // (image_url etc.) stay arrays, tool history keeps its linkage fields.
    const out: any = { role: m.role, content: m.content ?? null }
    if (m.name) out.name = m.name
    if (m.tool_call_id) out.tool_call_id = m.tool_call_id
    if (m.tool_calls) out.tool_calls = m.tool_calls
    return out
  })) as any[]

  // Forward agentic payloads the upstream supports (verified: tool_calls,
  // vision, reasoning_content on the chat engine).
  const toolPayload: Record<string, any> = {}
  if (body.tools) toolPayload.tools = body.tools
  if (body.tool_choice !== undefined) toolPayload.tool_choice = body.tool_choice
  if (body.response_format !== undefined) toolPayload.response_format = body.response_format

  const id = `chatcmpl-${Date.now().toString(36)}`
  const created = Math.floor(Date.now() / 1000)
  const lifetime = providerLifetime(req, res, 240_000)
  const paid = paidRequest(req, res)

  try {
    if (body.max_tokens !== undefined && body.max_completion_tokens !== undefined && body.max_tokens !== body.max_completion_tokens) throw new ApiBillingError('invalid_request')
    const maxOutput = body.max_completion_tokens ?? body.max_tokens ?? Number(process.env.HF_MAX_TOKENS ?? 4096)
    if (!Number.isSafeInteger(maxOutput) || maxOutput < 1 || maxOutput > 32_000) throw new ApiBillingError('invalid_request')
    const context = apiCount(target.contextTokens)
    if (!context || context > 1_048_576) throw new ApiBillingError('invalid_request')
    const inputLimit = context - maxOutput
    // Reserve the full remaining model context, covering multimodal expansion,
    // hidden chat templates, system prompts and tool definitions conservatively.
    // The serialized UTF-8 bound also rejects oversized textual/tool payloads.
    if (inputLimit < 1 || Buffer.byteLength(JSON.stringify({ messages, ...toolPayload }), 'utf8') + 1024 + messages.length * 256 > inputLimit) throw new ApiBillingError('invalid_request')
    const amountMicros = netCostMicros(grossCostMicros({ kind: 'chat', tokensIn: inputLimit, tokensOut: maxOutput, tier: target.tier }), ctx.plan)
    await paid.reserve({ kind: 'chat', model: requestedModel, amountMicros,
      pricingSnapshot: { version: 'v1', plan: ctx.plan, tier: target.tier, inputPerMillion: chatRatesFor(target.tier).input,
        outputPerMillion: chatRatesFor(target.tier).output, discountPercent: Math.round(discountFor(ctx.plan) * 100), inputLimit, maxOutput },
      requestFingerprint: apiFingerprint([body, messages, toolPayload, model, target.tier, ctx.plan, inputLimit, maxOutput, amountMicros]) })
    const client = createClient('huggingface', undefined, target.baseUrl)
    lifetime.remaining()
    await paid.dispatch()
    lifetime.remaining()
    if (body.stream) {
      res.setHeader('Content-Type', 'text/event-stream')
      res.setHeader('Cache-Control', 'no-cache, no-transform')
      res.setHeader('Connection', 'keep-alive')
      res.flushHeaders?.()

      paid.startWork()
      const stream = await client.chat.completions.create({
        model,
        messages,
        stream: true,
        temperature: body.temperature ?? 0.7,
        max_tokens: maxOutput,
        stream_options: { include_usage: true },
        top_p: body.top_p,
        stop: body.stop as any,
        ...toolPayload,
      }, { signal: lifetime.signal, maxRetries: 0 })

      let outputBytes = 0
      let usage: any
      let lastFinish: string | null = null
      for await (const chunk of stream as any) {
        lifetime.remaining()
        const delta = chunk?.choices?.[0]?.delta?.content || ''
        outputBytes += Buffer.byteLength(JSON.stringify(chunk?.choices?.[0]?.delta ?? {}), 'utf8')
        if (outputBytes > maxOutput * 128 + 65_536) throw new Error('Output limit exceeded')
        const fr = chunk?.choices?.[0]?.finish_reason
        if (fr) lastFinish = fr
        if (chunk?.usage) {
          chatUsage(chunk.usage, inputLimit, maxOutput)
          usage = chunk.usage
        }
        // Re-emit with our own ids so the response is self-consistent.
        // Deltas pass through the identity sanitizer.
        const sanitizedDelta = delta ? sanitizeIdentity(delta) : delta
        const outDelta = chunk?.choices?.[0]?.delta || {}
        if (delta && sanitizedDelta !== delta) {
          if (outDelta.content !== undefined) outDelta.content = sanitizedDelta
        }
        const out = {
          id,
          object: 'chat.completion.chunk',
          created,
          model: requestedModel,
          choices: [
            {
              index: 0,
              delta: outDelta,
              // Publish successful termination only after the ledger commits.
              finish_reason: null,
            },
          ],
        }
        res.write(`data: ${JSON.stringify(out)}\n\n`)
      }

      lifetime.remaining()
      if (!lastFinish) throw new Error('Truncated stream')
      const { tokensIn, tokensOut } = chatUsage(usage, inputLimit, maxOutput)
      await paid.capture(netCostMicros(grossCostMicros({ kind: 'chat', tokensIn, tokensOut, tier: target.tier }), ctx.plan), tokensIn, tokensOut)

      res.write(
        `data: ${JSON.stringify({
          id,
          object: 'chat.completion.chunk',
          created,
          model: requestedModel,
          choices: [{ index: 0, delta: {}, finish_reason: lastFinish || 'stop' }],
          usage: { prompt_tokens: tokensIn, completion_tokens: tokensOut, total_tokens: tokensIn + tokensOut },
        })}\n\n`
      )
      res.write('data: [DONE]\n\n')
      return res.end()
    }

    paid.startWork()
    const completion: any = await client.chat.completions.create({
      model,
      messages,
      temperature: body.temperature ?? 0.7,
      max_tokens: maxOutput,
      top_p: body.top_p,
      stop: body.stop as any,
      ...toolPayload,
    }, { signal: lifetime.signal, maxRetries: 0 })

    lifetime.remaining()
    if (!completion?.choices?.[0]?.message || !completion?.choices?.[0]?.finish_reason) throw new Error('Incomplete completion')
    const upstreamMsg = completion?.choices?.[0]?.message || {}
    const content = upstreamMsg.content || ''
    if (typeof content !== 'string' || Buffer.byteLength(JSON.stringify(upstreamMsg), 'utf8') > maxOutput * 128 + 65_536) throw new Error('Invalid completion')
    const { tokensIn, tokensOut } = chatUsage(completion?.usage, inputLimit, maxOutput)
    const cost = await paid.capture(netCostMicros(grossCostMicros({ kind: 'chat', tokensIn, tokensOut, tier: target.tier }), ctx.plan), tokensIn, tokensOut)

    res.setHeader('X-Loop-Cost-USD', (cost / MICROS_PER_USD).toFixed(6))
    return res.json({
      id,
      object: 'chat.completion',
      created,
      model: requestedModel,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: sanitizeIdentity(content),
            ...(upstreamMsg.tool_calls ? { tool_calls: upstreamMsg.tool_calls } : {}),
            ...(upstreamMsg.reasoning_content ? { reasoning_content: upstreamMsg.reasoning_content } : {}),
          },
          finish_reason: completion?.choices?.[0]?.finish_reason || 'stop',
        },
      ],
      usage: {
        prompt_tokens: tokensIn,
        completion_tokens: tokensOut,
        total_tokens: tokensIn + tokensOut,
      },
    })
  } catch (error: any) {
    lifetime.stop()
    return await paid.failed(error, 'Upstream model request failed.')
  } finally {
    lifetime.dispose()
  }
}))

/** Upstream model served via HF serverless TEI. Override with HF_EMBED_MODEL. */
const EMBED_UPSTREAM = process.env.HF_EMBED_MODEL || 'sentence-transformers/all-MiniLM-L6-v2'

const embeddingsSchema = z.object({
  input: z.union([z.string().min(1).max(32_768), z.array(z.string().min(1).max(32_768)).min(1).max(128)]),
  model: z.string().min(1).max(256).optional(),
})

/** One deadline across all attempts, with prompt cancellation on disconnect. */
function providerLifetime(req: express.Request, res: express.Response, timeoutMs: number) {
  const controller = new AbortController()
  const deadline = Date.now() + timeoutMs
  const cancel = () => controller.abort()
  req.once('aborted', cancel)
  res.once('close', cancel)
  const timer = setTimeout(cancel, timeoutMs)
  timer.unref()
  if (req.aborted || res.destroyed) cancel()
  return {
    signal: controller.signal,
    stop: cancel,
    remaining() {
      const ms = deadline - Date.now()
      if (controller.signal.aborted || ms <= 0) throw new Error('Provider request stopped.')
      return ms
    },
    dispose() {
      clearTimeout(timer)
      req.off('aborted', cancel)
      res.off('close', cancel)
      cancel()
    },
  }
}

/** Mean-pool token-level matrices into one vector; pass through pooled ones. */
function toEmbeddingVector(row: unknown): number[] {
  if (!Array.isArray(row) || !row.length) return []
  if (typeof row[0] === 'number') return row as number[]
  if (!Array.isArray(row[0]) || !row[0].length) return []
  const matrix = row as number[][]
  const dim = matrix[0].length
  if (matrix.some(vec => !Array.isArray(vec) || vec.length !== dim || vec.some(value => !Number.isFinite(value)))) return []
  const out = new Array<number>(dim).fill(0)
  for (const vec of matrix) for (let i = 0; i < dim; i++) out[i] += vec[i]
  return out.map((v) => v / matrix.length)
}

/**
 * POST /v1/embeddings — OpenAI-compatible embeddings backed by HF serverless
 * TEI. Metered through reservations at the standard chat rate (embeddings
 * cost orders of magnitude less than chat; a dedicated rate can be carved
 * out later without changing this surface).
 */
router.post('/embeddings', authenticateApiKey, asyncHandler(async (req: ApiRequest, res) => {
  const parsed = embeddingsSchema.safeParse(req.body)
  if (!parsed.success) {
    return apiError(
      res,
      400,
      parsed.error.issues[0]?.message || 'Invalid request body.',
      'invalid_request_error',
      'invalid_body'
    )
  }
  const ctx = req.api!
  const inputs = Array.isArray(parsed.data.input) ? parsed.data.input : [parsed.data.input]
  const requested = parsed.data.model || 'loop-embed'
  const created = Math.floor(Date.now() / 1000)

  const lifetime = providerLifetime(req, res, 60_000)
  const paid = paidRequest(req, res)
  try {
    // TEI does not return token usage. The public metering contract for this
    // endpoint is one estimated token per UTF-8 input byte + two special tokens
    // per input. Use the SAME deterministic count for reservation and capture.
    const tokens = apiCount(inputs.reduce((sum, s) => sum + Buffer.byteLength(s, 'utf8') + 2, 0))
    if (tokens > 262_144) throw new ApiBillingError('invalid_request')
    const amountMicros = netCostMicros(grossCostMicros({ kind: 'embedding', tokensIn: tokens }), ctx.plan)
    await paid.reserve({ kind: 'embedding', model: requested, amountMicros,
      pricingSnapshot: { version: 'v1', plan: ctx.plan, inputPerMillion: chatRatesFor('standard').input,
        discountPercent: Math.round(discountFor(ctx.plan) * 100), tokens, estimator: 'utf8-bytes-plus-special-tokens' },
      requestFingerprint: apiFingerprint([inputs, EMBED_UPSTREAM, ctx.plan, tokens, amountMicros]) })
    lifetime.remaining()
    await paid.dispatch()
    lifetime.remaining()
    paid.startWork()
    const upstream = await providerRequest(
      `https://router.huggingface.co/hf-inference/models/${EMBED_UPSTREAM}/pipeline/feature-extraction`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.HF_TOKEN || process.env.HF_API_TOKEN || ''}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ inputs, options: { wait_for_model: true } }),
        allowedOrigins: ['https://router.huggingface.co'],
        timeoutMs: lifetime.remaining(),
        maxBytes: 8 * 1024 * 1024,
        signal: lifetime.signal,
      }
    )
    const raw: unknown = await upstream.json()
    lifetime.remaining()
    if (!Array.isArray(raw)) throw new Error('embeddings upstream returned unexpected payload')

    // Shapes observed from TEI: [float] (single), [ [float…] ] (pooled batch),
    // [ [ [float…]…] ] (token-level, needs mean-pooling).
    const first = (raw as unknown[])[0]
    const vectors = Array.isArray(first)
      ? (raw as unknown[][]).map(toEmbeddingVector)
      : [toEmbeddingVector(raw)]
    if (vectors.length !== inputs.length || vectors.some(vector => !vector.length || vector.some(value => !Number.isFinite(value)))) {
      throw new Error('Invalid embeddings payload.')
    }
    const cost = await paid.capture(amountMicros, tokens)
    lifetime.remaining()
    res.setHeader('X-Loop-Cost-USD', (cost / MICROS_PER_USD).toFixed(6))
    res.setHeader('X-Loop-Usage-Estimated', 'utf8-bytes-plus-special-tokens')

    return res.json({
      object: 'list',
      created,
      model: requested,
      data: vectors.map((embedding, index) => ({ object: 'embedding', index, embedding })),
      usage: { prompt_tokens: tokens, total_tokens: tokens },
    })
  } catch (error) {
    lifetime.stop()
    return await paid.failed(error, 'Upstream embeddings request failed.')
  } finally {
    lifetime.dispose()
  }
}))

/**
 * Call the dedicated HF image endpoint once.
 *
 * No automatic paid POST retries: a gateway 502/503/504 is not proof that the
 * upstream did no billable work. Such failures retain the hold for reconciliation.
 */
async function generateOne(
  endpoint: string, prompt: string, lifetime: ReturnType<typeof providerLifetime>,
): Promise<string> {
  const upstream = await providerRequest(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.HF_TOKEN || process.env.HF_API_TOKEN || ''}`,
      'Content-Type': 'application/json',
      Accept: 'image/png',
    },
    body: JSON.stringify({
      inputs: prompt,
      parameters: { num_inference_steps: 28, guidance_scale: 3.5 },
    }),
    // endpoint is operator configuration, never a request field.
    allowedOrigins: [new URL(endpoint).origin],
    timeoutMs: lifetime.remaining(),
    maxBytes: 16 * 1024 * 1024,
    signal: lifetime.signal,
  })
  lifetime.remaining()
  const contentType = upstream.headers.get('content-type') || ''
  if (contentType.includes('application/json')) {
    const payload: any = await upstream.json()
    const b64 =
      payload?.image || payload?.[0]?.image || payload?.images?.[0]?.b64_json || payload?.data?.[0]?.b64_json
    if (typeof b64 === 'string' && /^[A-Za-z0-9+/]+={0,2}$/.test(b64) && Buffer.from(b64, 'base64').length) return b64
    throw new Error('Invalid image payload.')
  }
  if (!contentType.startsWith('image/') || !upstream.body.length) throw new Error('Invalid image payload.')
  return upstream.body.toString('base64')
}

const imageSchema = z.object({
  prompt: z.string().trim().min(1).max(2_000),
  model: z.string().min(1).max(256).optional(),
  n: z.number().int().min(1).max(4).optional(),
  size: z.string().optional(),
  response_format: z.enum(['b64_json', 'url']).optional(),
})

/** POST /v1/images/generations — text-to-image. */
router.post('/images/generations', authenticateApiKey, asyncHandler(async (req: ApiRequest, res) => {
  const parsed = imageSchema.safeParse(req.body)
  if (!parsed.success) {
    return apiError(
      res,
      400,
      parsed.error.issues[0]?.message || 'Invalid request body.',
      'invalid_request_error',
      'invalid_body'
    )
  }
  const ctx = req.api!
  const { prompt, n = 1, response_format = 'url' } = parsed.data

  const endpoint = (process.env.HF_IMAGE_ENDPOINT_URL || '').replace(/\/+$/, '')
  if (!endpoint) {
    return apiError(res, 503, 'Image generation is not configured.', 'api_error', 'not_configured')
  }

  const lifetime = providerLifetime(req, res, 240_000)
  const paid = paidRequest(req, res)
  const images: { b64: string }[] = []
  try {
    const amountMicros = netCostMicros(grossCostMicros({ kind: 'image', units: n }), ctx.plan)
    await paid.reserve({ kind: 'image', model: parsed.data.model || 'loop-image', amountMicros,
      pricingSnapshot: { version: 'v1', plan: ctx.plan, perUnitMicros: RATE_IMAGE, discountPercent: Math.round(discountFor(ctx.plan) * 100), units: n },
      requestFingerprint: apiFingerprint([parsed.data, ctx.plan, amountMicros]) })
    const endpointUrl = new URL(endpoint)
    if (endpointUrl.protocol !== 'https:' || endpointUrl.username || endpointUrl.password) throw new Error('Invalid endpoint')
    lifetime.remaining()
    await paid.dispatch()
    for (let i = 0; i < n; i++) {
      lifetime.remaining()
      paid.startWork()
      images.push({ b64: await generateOne(endpoint, prompt, lifetime) })
    }
    lifetime.remaining()

    const cost = await paid.capture(amountMicros, 0, 0, images.length)
    lifetime.remaining()

    res.setHeader('X-Loop-Cost-USD', (cost / MICROS_PER_USD).toFixed(6))
    const data = await Promise.all(images.map(async (img, idx) => {
      if (response_format === 'b64_json') return { b64_json: img.b64 }
      const artifact = await saveArtifact(
        `api-${Date.now().toString(36)}-${idx}.png`,
        Buffer.from(img.b64, 'base64'), { userId: ctx.userId }
      )
      const base = (process.env.PUBLIC_API_URL || '').replace(/\/+$/, '')
      return { url: base ? `${base}${artifact.url}` : artifact.url }
    }))
    lifetime.remaining()
    return res.json({ created: Math.floor(Date.now() / 1000), data })
  } catch (error) {
    lifetime.stop()
    return await paid.failed(error, 'Image generation failed.', images.length)
  } finally {
    lifetime.dispose()
  }
}))

function serializeVideoJob(job: any) {
  return {
    id: job.id,
    object: 'video.generation',
    status: job.status, // queued | processing | completed | failed | cancelled
    progress: job.progress,
    prompt: job.prompt,
    url: job.outputUrl
      ? `${(process.env.PUBLIC_API_URL || '').replace(/\/+$/, '')}${job.outputUrl}`
      : null,
    error: job.error,
    created_at: job.createdAt,
    completed_at: job.completedAt,
  }
}

/** Server-generated job identities; this endpoint is NOT HTTP-idempotent.
 * No provider I/O or process-local work starts in the request handler. */
router.post('/videos/generations', authenticateApiKey, asyncHandler(async (req: ApiRequest, res) => {
  try {
    const job = await createAccountedVideoJob(req.api!, req.body)
    return res.status(202).json(serializeVideoJob(job))
  } catch (error) {
    const limit = videoQueueLimitProjection(error)
    if (limit) return apiError(res, limit.status, limit.message, 'api_error', limit.code)
    const status = error instanceof ApiBillingError && error.code === 'insufficient_quota' ? 402 :
      error instanceof VideoJobError && error.code === 'invalid_request' ? 400 : 503
    return apiError(res, status, status === 402 ? 'Insufficient prepaid credit.' : status === 400 ? 'Invalid video request.' : 'Video billing is temporarily unavailable.',
      'api_error', status === 503 ? 'video_accounting_unavailable' : status === 402 ? 'insufficient_quota' : 'invalid_request')
  }
}))

/** GET /v1/videos/generations/:id — poll an async video job. */
router.get('/videos/generations/:id', authenticateApiKey, asyncHandler(async (req: ApiRequest, res) => {
  if (!hasDb || !prisma) {
    return apiError(res, 503, 'Video jobs require a database.', 'api_error', 'not_configured')
  }
  const job = await prisma.mediaJob.findFirst({
    where: { id: req.params.id, userId: req.api!.userId, OR: [
      { accountedVideo: { is: null } },
      { accountedVideo: { is: { dailyReservationId: null, reservation: { is: { apiKeyId: req.api!.apiKeyId, userId: req.api!.userId } } } } },
    ] },
  })
  if (!job) return apiError(res, 404, 'Video job not found.', 'invalid_request_error', 'not_found')
  return res.json(serializeVideoJob(job))
}))

router.post('/videos/generations/:id/cancel', authenticateApiKey, asyncHandler(async (req: ApiRequest, res) => {
  try { await cancelAccountedVideoJob(req.params.id, req.api!); return res.json({ ok: true }) }
  catch (error) {
    const status = error instanceof VideoJobError && error.code === 'not_found' ? 404 : 503
    return apiError(res, status, status === 404 ? 'Video job not found.' : 'Video accounting unavailable.', 'api_error', status === 404 ? 'not_found' : 'video_accounting_unavailable')
  }
}))

/** GET /v1/usage — balance and recent spend for the calling key's account. */
router.get('/usage', authenticateApiKey, asyncHandler(async (req: ApiRequest, res) => {
  if (!hasDb || !prisma) {
    return apiError(res, 503, 'Usage requires a database.', 'api_error', 'not_configured')
  }
  const ctx = req.api!
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
  const [user, agg, holds] = await Promise.all([
    prisma.user.findUnique({
      where: { id: ctx.userId },
      select: { apiBalanceMicros: true, apiPlan: true },
    }),
    prisma.apiUsage.aggregate({
      where: { userId: ctx.userId, createdAt: { gte: since } },
      _sum: { costMicros: true, tokensIn: true, tokensOut: true, units: true },
      _count: true,
    }),
    prisma.apiReservation.groupBy({ by: ['state'], where: { userId: ctx.userId, state: { in: ['reserved', 'dispatched', 'unknown'] } }, _sum: { amountMicros: true }, _count: true }),
  ])
  return res.json({
    object: 'usage',
    balance_usd: Number(user?.apiBalanceMicros ?? 0n) / MICROS_PER_USD,
    // Outstanding holds are visible and durable even after process termination.
    reservations: holds.map(row => ({ state: row.state, count: row._count, held_usd: Number(row._sum.amountMicros ?? 0n) / MICROS_PER_USD })),
    plan: user?.apiPlan ?? null,
    last_30_days: {
      requests: agg._count,
      tokens_in: agg._sum.tokensIn || 0,
      tokens_out: agg._sum.tokensOut || 0,
      units: agg._sum.units || 0,
      spend_usd: Number(agg._sum.costMicros ?? 0n) / MICROS_PER_USD,
    },
  })
}))

/**
 * POST /v1/media/publish — publish a base64 media blob (generated video/image)
 * to owned storage. Returned URLs require the owner's JWT or developer key.
 */
router.post('/media/publish', authenticateApiKey, asyncHandler(async (req: ApiRequest, res) => {
  const { mime, b64, name } = req.body || {}
  if (!b64 || typeof b64 !== 'string') {
    return apiError(res, 400, 'Missing b64 payload.', 'invalid_request_error', 'missing_payload')
  }
  let buf: Buffer
  try {
    buf = Buffer.from(b64, 'base64')
  } catch {
    return apiError(res, 400, 'Invalid base64 payload.', 'invalid_request_error', 'invalid_payload')
  }
  if (!buf.length || buf.length > 50 * 1024 * 1024) {
    return apiError(res, 413, 'Payload empty or too large (max 50MB decoded).', 'invalid_request_error', 'payload_too_large')
  }
  const extByMime: Record<string, string> = {
    'video/mp4': 'mp4',
    'video/webm': 'webm',
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
  }
  let ext = extByMime[String(mime || '').toLowerCase()] || ''
  if (!ext && typeof name === 'string' && /\.[a-z0-9]{2,5}$/i.test(name)) {
    ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
  }
  if (!ext) ext = 'bin'
  try {
    const artifact = await saveArtifact(`media.${ext}`, buf, { userId: req.api!.userId })
    const base = (process.env.PUBLIC_API_URL || '').replace(/\/+$/, '')
    return res.json({ object: 'media.publish', id: artifact.id, access: 'private', url: `${base}${artifact.url}`,
      bytes: buf.length, mime: artifact.mimeType })
  } catch (e: any) {
    return apiError(res, 503, 'Private media storage is unavailable.', 'api_error', 'persist_failed')
  }
}))

/** Unknown /v1 path — OpenAI-style 404 so SDKs report it cleanly. */
router.use((req, res) =>
  apiError(res, 404, `Unknown endpoint: ${req.method} /v1${req.path}`, 'invalid_request_error', 'unknown_endpoint')
)

export default router
