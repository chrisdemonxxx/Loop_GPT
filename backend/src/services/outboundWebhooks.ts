/**
 * Outbound Webhook Delivery Service (Tier 2-2).
 *
 * Delivers signed HMAC-SHA256 webhook events (`video.completed`, `bot.run.completed`,
 * `batch.completed`, etc.) to the caller-configured `ApiKey.webhookUrl` when an
 * async job finishes.
 *
 * Security:
 * - Only `https://` targets are permitted (checked against SSRF via publicHttp or URL validation).
 * - Every delivery includes:
 *     `X-Loop-Webhook-Timestamp`: unix epoch seconds
 *     `X-Loop-Webhook-Signature`: `t=<ts>,v1=<hex_hmac_sha256("<ts>.<raw_json>", secret)>`
 */
import crypto from 'crypto'
import { prisma, hasDb } from './prisma'

export interface OutboundWebhookEvent {
  id: string
  type: 'video.completed' | 'video.failed' | 'bot.run.completed' | 'bot.run.failed' | 'batch.completed' | 'batch.failed'
  created: number
  data: Record<string, unknown>
}

export function signWebhookPayload(payload: string, secret: string, timestampSec = Math.floor(Date.now() / 1000)): {
  timestamp: string
  signature: string
} {
  const signedContent = `${timestampSec}.${payload}`
  const digest = crypto.createHmac('sha256', secret).update(signedContent, 'utf8').digest('hex')
  return {
    timestamp: String(timestampSec),
    signature: `t=${timestampSec},v1=${digest}`,
  }
}

export function verifyWebhookSignature(payload: string, header: string, secret: string, toleranceSec = 300): boolean {
  if (!header || !secret) return false
  const parts = Object.fromEntries(
    header.split(',').map((part) => {
      const [k, v] = part.trim().split('=')
      return [k, v]
    }),
  )
  const ts = Number(parts.t)
  const sig = parts.v1
  if (!Number.isSafeInteger(ts) || !sig) return false
  const nowSec = Math.floor(Date.now() / 1000)
  if (Math.abs(nowSec - ts) > toleranceSec) return false
  const expected = signWebhookPayload(payload, secret, ts).signature.split('v1=')[1]
  if (!expected || expected.length !== sig.length) return false
  return crypto.timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(sig, 'utf8'))
}

function isSafeWebhookUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl)
    if (parsed.protocol !== 'https:') return false
    const host = parsed.hostname.toLowerCase()
    if (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '::1' ||
      host.endsWith('.internal') ||
      host.endsWith('.local') ||
      /^10\./.test(host) ||
      /^192\.168\./.test(host) ||
      /^172\.(1[6-9]|2\d|3[0-1])\./.test(host) ||
      /^169\.254\./.test(host)
    ) {
      return false
    }
    return true
  } catch {
    return false
  }
}

/**
 * Deliver an outbound webhook for a given `apiKeyId` (or the user's most recent
 * key with a webhook configured when `apiKeyId` is omitted). Retries up to 3
 * times with exponential backoff on 5xx / network errors.
 */
export async function deliverOutboundWebhook(params: {
  userId: string
  apiKeyId?: string | null
  type: OutboundWebhookEvent['type']
  data: Record<string, unknown>
  fetchImpl?: typeof fetch
}): Promise<{ delivered: boolean; status?: number; reason?: string }> {
  if (!hasDb || !prisma) return { delivered: false, reason: 'no_db' }

  const key = params.apiKeyId
    ? await prisma.apiKey.findFirst({
        where: { id: params.apiKeyId, userId: params.userId, revoked: false },
        select: { webhookUrl: true, webhookSecret: true },
      })
    : await prisma.apiKey.findFirst({
        where: { userId: params.userId, revoked: false, webhookUrl: { not: null } },
        orderBy: { createdAt: 'desc' },
        select: { webhookUrl: true, webhookSecret: true },
      })

  if (!key?.webhookUrl) return { delivered: false, reason: 'no_webhook_configured' }
  if (!isSafeWebhookUrl(key.webhookUrl)) return { delivered: false, reason: 'unsafe_webhook_url' }

  const event: OutboundWebhookEvent = {
    id: `evt_${crypto.randomBytes(12).toString('hex')}`,
    type: params.type,
    created: Math.floor(Date.now() / 1000),
    data: params.data,
  }
  const body = JSON.stringify(event)
  const secret = key.webhookSecret || 'whsec_unsigned'
  const { timestamp, signature } = signWebhookPayload(body, secret)
  const doFetch = params.fetchImpl || fetch

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 10_000)
      timer.unref?.()
      const resp = await doFetch(key.webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'LoopGPT-Webhook/1.0',
          'X-Loop-Webhook-Id': event.id,
          'X-Loop-Webhook-Timestamp': timestamp,
          'X-Loop-Webhook-Signature': signature,
        },
        body,
        signal: controller.signal,
      })
      clearTimeout(timer)
      if (resp.status >= 200 && resp.status < 300) {
        return { delivered: true, status: resp.status }
      }
      if (resp.status < 500 && resp.status !== 429) {
        return { delivered: false, status: resp.status, reason: 'client_rejected' }
      }
    } catch {
      // Retry on transient error
    }
    if (attempt < 2) {
      await new Promise((r) => setTimeout(r, 200 * 2 ** attempt))
    }
  }
  return { delivered: false, reason: 'retries_exhausted' }
}
