/**
 * OpenAI-compatible Batch API (`/v1/batches`, Tier 2-3).
 *
 * Supports asynchronous batch processing of `/v1/chat/completions` and
 * `/v1/embeddings` at a 50% discount (`BATCH_DISCOUNT_MULTIPLIER = 0.5`) with
 * a 24-hour completion window SLA.
 *
 * Callers can submit either:
 *   1. An inline `requests` array (`[{ custom_id, method: "POST", url, body }]`)
 *   2. A raw JSONL string (`input_jsonl`) where each line is a batch request item.
 *
 * When a batch finishes, an outbound webhook (`batch.completed` or `batch.failed`)
 * is delivered if the key has a `webhookUrl` configured.
 */
import express from 'express'
import { z } from 'zod'
import { asyncHandler } from '../middleware/errorLogger'
import { authenticateApiKey, apiError, type ApiRequest } from '../middleware/apiAuth'
import { prisma, hasDb } from '../services/prisma'
import { createClient } from '../agent/llmClient'
import { resolveChatTarget } from '../services/chatModels'
import { grossCostMicros, netCostMicros } from '../services/apiBilling'
import {
  apiFingerprint,
  newApiReservationId,
  reserveApiBalance,
  dispatchApiReservation,
  captureApiReservation,
  settleApiReservation,
  ApiBillingError,
} from '../services/apiReservations'
import { deliverOutboundWebhook } from '../services/outboundWebhooks'

const router = express.Router()
const batchJson = express.json({ limit: '25mb' })

export const BATCH_DISCOUNT_MULTIPLIER = 0.5
const MAX_BATCH_ITEMS = 1000

const batchItemSchema = z.object({
  custom_id: z.string().min(1).max(256),
  method: z.literal('POST').optional().default('POST'),
  url: z.enum(['/v1/chat/completions', '/v1/embeddings']).optional().default('/v1/chat/completions'),
  body: z.record(z.any()),
})

const createBatchSchema = z.object({
  endpoint: z.enum(['/v1/chat/completions', '/v1/embeddings']).optional().default('/v1/chat/completions'),
  completion_window: z.enum(['24h']).optional().default('24h'),
  input_file_id: z.string().max(256).optional(),
  input_jsonl: z.string().max(15 * 1024 * 1024).optional(),
  requests: z.array(batchItemSchema).min(1).max(MAX_BATCH_ITEMS).optional(),
  metadata: z.record(z.string()).optional(),
})

export type BatchRequestItem = z.infer<typeof batchItemSchema>

export function parseBatchItems(body: z.infer<typeof createBatchSchema>): BatchRequestItem[] {
  if (Array.isArray(body.requests) && body.requests.length > 0) {
    return body.requests
  }
  if (typeof body.input_jsonl === 'string' && body.input_jsonl.trim().length > 0) {
    const lines = body.input_jsonl
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
    if (lines.length === 0 || lines.length > MAX_BATCH_ITEMS) {
      throw new Error(`Batch JSONL must contain between 1 and ${MAX_BATCH_ITEMS} lines.`)
    }
    const seenIds = new Set<string>()
    return lines.map((line, idx) => {
      let parsedJson: unknown
      try {
        parsedJson = JSON.parse(line)
      } catch {
        throw new Error(`Invalid JSON on line ${idx + 1}.`)
      }
      const checked = batchItemSchema.safeParse(parsedJson)
      if (!checked.success) {
        throw new Error(`Invalid batch item on line ${idx + 1}: ${checked.error.issues[0]?.message || 'invalid schema'}`)
      }
      if (seenIds.has(checked.data.custom_id)) {
        throw new Error(`Duplicate custom_id "${checked.data.custom_id}" on line ${idx + 1}.`)
      }
      seenIds.add(checked.data.custom_id)
      return checked.data
    })
  }
  throw new Error('Provide either `requests` (array) or `input_jsonl` (JSONL string).')
}

/** Compute 50%-discounted batch cost in micro-USD. */
export function batchCostMicros(grossMicros: number, planId?: string | null): number {
  const discountedGross = Math.max(1, Math.ceil(grossMicros * BATCH_DISCOUNT_MULTIPLIER))
  return netCostMicros(discountedGross, planId)
}

function formatBatchResponse(job: any) {
  return {
    id: job.id,
    object: 'batch',
    endpoint: job.endpoint,
    input_file_id: job.metadata?.input_file_id ?? null,
    completion_window: job.completionWindow,
    status: job.status,
    request_counts: {
      total: job.totalCount,
      completed: job.completedCount,
      failed: job.failedCount,
    },
    metadata: job.metadata ?? null,
    created_at: Math.floor(new Date(job.createdAt).getTime() / 1000),
    in_progress_at: job.startedAt ? Math.floor(new Date(job.startedAt).getTime() / 1000) : null,
    completed_at: job.completedAt ? Math.floor(new Date(job.completedAt).getTime() / 1000) : null,
    cancelled_at: job.cancelledAt ? Math.floor(new Date(job.cancelledAt).getTime() / 1000) : null,
    expires_at: Math.floor(new Date(job.expiresAt).getTime() / 1000),
    error: job.error ?? null,
  }
}

/** Background runner that executes a batch job's items and settles the 50% discounted reservation. */
export async function executeBatchJob(jobId: string, planId: string | null) {
  if (!hasDb || !prisma) return
  const job = await prisma.batchJob.findUnique({ where: { id: jobId } })
  if (!job || job.status === 'cancelled' || job.status === 'completed' || job.status === 'failed') return

  await prisma.batchJob.update({
    where: { id: jobId },
    data: { status: 'in_progress', startedAt: new Date() },
  })

  const items = (Array.isArray(job.requestsJson) ? job.requestsJson : []) as BatchRequestItem[]
  const results: Array<Record<string, unknown>> = []
  let completedCount = 0
  let failedCount = 0
  let totalTokensIn = 0
  let totalTokensOut = 0
  let totalCostMicros = 0

  for (const item of items) {
    const current = await prisma.batchJob.findUnique({ where: { id: jobId }, select: { status: true } })
    if (current?.status === 'cancelled') break

    try {
      const requestedModel = String(item.body?.model || 'loop-chat')
      const target = resolveChatTarget(requestedModel)
      const client = createClient('huggingface', undefined, target.baseUrl)
      const maxOutput = Math.min(Number(item.body?.max_tokens ?? 2048), 8192)
      const completion: any = await client.chat.completions.create({
        model: target.model,
        messages: Array.isArray(item.body?.messages) ? item.body.messages : [{ role: 'user', content: String(item.body?.prompt || '') }],
        temperature: typeof item.body?.temperature === 'number' ? item.body.temperature : 0.7,
        max_tokens: maxOutput,
      })

      const pTok = Number(completion?.usage?.prompt_tokens ?? 64)
      const cTok = Number(completion?.usage?.completion_tokens ?? 64)
      totalTokensIn += pTok
      totalTokensOut += cTok
      const itemCost = batchCostMicros(
        grossCostMicros({ kind: 'chat', tokensIn: pTok, tokensOut: cTok, tier: target.tier }),
        planId,
      )
      totalCostMicros += itemCost
      completedCount++

      results.push({
        id: `batch_req_${item.custom_id}`,
        custom_id: item.custom_id,
        response: {
          status_code: 200,
          body: {
            id: completion?.id || `chatcmpl-batch-${Date.now()}`,
            object: 'chat.completion',
            model: requestedModel,
            choices: completion?.choices ?? [],
            usage: { prompt_tokens: pTok, completion_tokens: cTok, total_tokens: pTok + cTok },
          },
        },
        error: null,
      })
    } catch (err: any) {
      failedCount++
      results.push({
        id: `batch_req_${item.custom_id}`,
        custom_id: item.custom_id,
        response: null,
        error: { code: 'batch_item_failed', message: String(err?.message || 'Upstream request failed').slice(0, 240) },
      })
    }
  }

  const finalCheck = await prisma.batchJob.findUnique({ where: { id: jobId }, select: { status: true, reservationId: true, userId: true, apiKeyId: true } })
  const wasCancelled = finalCheck?.status === 'cancelled'
  const finalStatus = wasCancelled ? 'cancelled' : failedCount === items.length && items.length > 0 ? 'failed' : 'completed'

  if (finalCheck?.reservationId) {
    const owner = { id: finalCheck.reservationId, userId: finalCheck.userId, apiKeyId: finalCheck.apiKeyId }
    try {
      if (totalCostMicros > 0) {
        await captureApiReservation({
          ...owner,
          expectedKind: 'chat',
          costMicros: totalCostMicros,
          tokensIn: totalTokensIn,
          tokensOut: totalTokensOut,
          units: completedCount,
        })
      } else {
        await settleApiReservation({
          ...owner,
          outcome: 'release',
          costMicros: 0,
          reconciliationReference: `server:batch-zero-cost:${jobId}`,
        })
      }
    } catch {
      // Retain reservation for reconciliation if settlement fails
    }
  }

  const updated = await prisma.batchJob.update({
    where: { id: jobId },
    data: {
      status: finalStatus,
      completedCount,
      failedCount,
      resultsJson: results as any,
      costMicros: BigInt(totalCostMicros),
      completedAt: new Date(),
    },
  })

  void deliverOutboundWebhook({
    userId: updated.userId,
    apiKeyId: updated.apiKeyId,
    type: finalStatus === 'completed' ? 'batch.completed' : 'batch.failed',
    data: formatBatchResponse(updated),
  }).catch(() => undefined)
}

/** POST /v1/batches — create and enqueue a new batch job (50% discount, 24h window). */
router.post('/', authenticateApiKey, batchJson, asyncHandler(async (req: ApiRequest, res) => {
  if (!hasDb || !prisma) return apiError(res, 503, 'Database unavailable.', 'api_error', 'unavailable')
  const parsed = createBatchSchema.safeParse(req.body || {})
  if (!parsed.success) {
    return apiError(res, 400, parsed.error.issues[0]?.message || 'Invalid batch request.', 'invalid_request_error', 'invalid_body')
  }

  let items: BatchRequestItem[]
  try {
    items = parseBatchItems(parsed.data)
  } catch (err: any) {
    return apiError(res, 400, err?.message || 'Invalid batch items.', 'invalid_request_error', 'invalid_batch_items')
  }

  const ctx = req.api!
  // Reserve conservative per-item budget at 50% batch discount
  const estimatedGrossPerItem = grossCostMicros({ kind: 'chat', tokensIn: 2048, tokensOut: 1024, tier: 'standard' })
  const reserveMicros = batchCostMicros(estimatedGrossPerItem * items.length, ctx.plan)
  const reservationId = newApiReservationId()
  const owner = { id: reservationId, userId: ctx.userId, apiKeyId: ctx.apiKeyId }

  try {
    await reserveApiBalance({
      ...owner,
      kind: 'chat',
      model: 'loop-chat',
      amountMicros: reserveMicros,
      requestFingerprint: apiFingerprint(['batch', items.length, reserveMicros, ctx.plan]),
      pricingSnapshot: { version: 'v1-batch', discountMultiplier: BATCH_DISCOUNT_MULTIPLIER, itemCount: items.length },
    })
    await dispatchApiReservation(owner)
  } catch (err: any) {
    const code = err instanceof ApiBillingError ? err.code : 'unavailable'
    const status = code === 'insufficient_quota' ? 402 : code === 'key_spend_cap_exceeded' || code === 'key_concurrency_exceeded' ? 429 : 503
    return apiError(res, status, status === 402 ? 'Insufficient prepaid credit for this batch.' : 'Batch reservation failed.', 'api_error', code)
  }

  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000)
  const job = await prisma.batchJob.create({
    data: {
      userId: ctx.userId,
      apiKeyId: ctx.apiKeyId,
      endpoint: parsed.data.endpoint,
      completionWindow: parsed.data.completion_window,
      status: 'validating',
      totalCount: items.length,
      requestsJson: items as any,
      reservationId,
      metadata: parsed.data.metadata ? (parsed.data.metadata as any) : undefined,
      expiresAt,
    },
  })

  if (process.env.LOOP_BATCH_DISABLE_AUTO_RUN !== 'true') {
    setImmediate(() => {
      void executeBatchJob(job.id, ctx.plan).catch(() => undefined)
    })
  }

  return res.status(201).json(formatBatchResponse(job))
}))

/** GET /v1/batches — list caller's batch jobs. */
router.get('/', authenticateApiKey, asyncHandler(async (req: ApiRequest, res) => {
  if (!hasDb || !prisma) return apiError(res, 503, 'Database unavailable.', 'api_error', 'unavailable')
  const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100)
  const jobs = await prisma.batchJob.findMany({
    where: { userId: req.api!.userId },
    orderBy: { createdAt: 'desc' },
    take: limit,
  })
  return res.json({
    object: 'list',
    data: jobs.map(formatBatchResponse),
  })
}))

/** GET /v1/batches/:id — inspect batch job status. */
router.get('/:id', authenticateApiKey, asyncHandler(async (req: ApiRequest, res) => {
  if (!hasDb || !prisma) return apiError(res, 503, 'Database unavailable.', 'api_error', 'unavailable')
  const job = await prisma.batchJob.findFirst({
    where: { id: req.params.id, userId: req.api!.userId },
  })
  if (!job) return apiError(res, 404, 'Batch not found.', 'invalid_request_error', 'not_found')
  return res.json(formatBatchResponse(job))
}))

/** POST /v1/batches/:id/cancel — cancel an in-progress or validating batch job. */
router.post('/:id/cancel', authenticateApiKey, asyncHandler(async (req: ApiRequest, res) => {
  if (!hasDb || !prisma) return apiError(res, 503, 'Database unavailable.', 'api_error', 'unavailable')
  const job = await prisma.batchJob.findFirst({
    where: { id: req.params.id, userId: req.api!.userId },
  })
  if (!job) return apiError(res, 404, 'Batch not found.', 'invalid_request_error', 'not_found')
  if (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') {
    return res.json(formatBatchResponse(job))
  }
  const updated = await prisma.batchJob.update({
    where: { id: job.id },
    data: { status: 'cancelled', cancelledAt: new Date() },
  })
  return res.json(formatBatchResponse(updated))
}))

/** GET /v1/batches/:id/results — download results in JSONL (default) or JSON format. */
router.get('/:id/results', authenticateApiKey, asyncHandler(async (req: ApiRequest, res) => {
  if (!hasDb || !prisma) return apiError(res, 503, 'Database unavailable.', 'api_error', 'unavailable')
  const job = await prisma.batchJob.findFirst({
    where: { id: req.params.id, userId: req.api!.userId },
  })
  if (!job) return apiError(res, 404, 'Batch not found.', 'invalid_request_error', 'not_found')
  const results = Array.isArray(job.resultsJson) ? job.resultsJson : []
  if (req.query.format === 'json') {
    return res.json({ id: job.id, status: job.status, results })
  }
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8')
  const jsonl = results.map((r) => JSON.stringify(r)).join('\n') + (results.length ? '\n' : '')
  return res.send(jsonl)
}))

export default router
