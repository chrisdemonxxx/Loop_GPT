/**
 * Developer API key issuance and verification.
 *
 * Keys look like `sk-loop-<48 hex chars>`. Only the sha256 hash is persisted, so
 * a database leak cannot yield working keys; the plaintext is returned exactly
 * once at creation time.
 */
import crypto from 'crypto'
import { prisma, hasDb } from './prisma'

const KEY_PREFIX = 'sk-loop-'
const SECRET_BYTES = 24

export interface IssuedKey {
  id: string
  name: string
  key: string // plaintext — shown once
  prefix: string
  createdAt: Date
}

export function hashKey(raw: string): string {
  return crypto.createHash('sha256').update(raw.trim()).digest('hex')
}

/** Masked display form, e.g. "sk-loop-a1b2c3…7f8e". */
export function maskKey(prefix: string): string {
  return `${prefix}…`
}

export function looksLikeApiKey(value: string): boolean {
  return typeof value === 'string' && value.trim().startsWith(KEY_PREFIX)
}

export async function createApiKey(userId: string, name?: string): Promise<IssuedKey> {
  if (!hasDb || !prisma) throw new Error('API keys require a configured database.')
  const secret = crypto.randomBytes(SECRET_BYTES).toString('hex')
  const raw = `${KEY_PREFIX}${secret}`
  const record = await prisma.apiKey.create({
    data: {
      userId,
      name: (name || 'Default key').slice(0, 60),
      keyHash: hashKey(raw),
      prefix: `${KEY_PREFIX}${secret.slice(0, 6)}`,
    },
  })
  return { id: record.id, name: record.name, key: raw, prefix: record.prefix, createdAt: record.createdAt }
}

export async function listApiKeys(userId: string) {
  if (!hasDb || !prisma) return []
  const keys = await prisma.apiKey.findMany({
    where: { userId, revoked: false },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      name: true,
      prefix: true,
      lastUsedAt: true,
      createdAt: true,
      spendCapMicros: true,
      concurrencyLimit: true,
      webhookUrl: true,
    },
  })
  return keys.map(({ spendCapMicros, ...k }) => ({
    ...k,
    masked: maskKey(k.prefix),
    spendCapUsd: spendCapMicros === null ? null : Number(spendCapMicros) / 1_000_000,
    webhookUrl: k.webhookUrl ?? null,
  }))
}

export interface KeyLimitsInput {
  /** Rolling 30-day cap in USD; null clears it; undefined leaves it unchanged. */
  spendCapUsd?: number | null
  /** Max in-flight requests; null clears it; undefined leaves it unchanged. */
  concurrencyLimit?: number | null
  /** Optional HTTPS webhook URL for async job events; null clears it. */
  webhookUrl?: string | null
  /** Optional webhook signing secret; if omitted when setting a new webhookUrl, one is generated. */
  webhookSecret?: string | null
}

/** Set or clear a key's per-key limits or webhook configuration. Returns false when the key isn't the caller's. */
export async function updateApiKeyLimits(userId: string, id: string, limits: KeyLimitsInput): Promise<boolean> {
  if (!hasDb || !prisma) return false
  const data: {
    spendCapMicros?: bigint | null
    concurrencyLimit?: number | null
    webhookUrl?: string | null
    webhookSecret?: string | null
  } = {}
  if (limits.spendCapUsd !== undefined) {
    data.spendCapMicros = limits.spendCapUsd === null ? null : BigInt(Math.round(limits.spendCapUsd * 1_000_000))
  }
  if (limits.concurrencyLimit !== undefined) data.concurrencyLimit = limits.concurrencyLimit
  if (limits.webhookUrl !== undefined) {
    data.webhookUrl = limits.webhookUrl
    if (limits.webhookUrl === null) {
      data.webhookSecret = null
    } else if (limits.webhookSecret !== undefined) {
      data.webhookSecret = limits.webhookSecret
    } else {
      data.webhookSecret = `whsec_${crypto.randomBytes(24).toString('hex')}`
    }
  } else if (limits.webhookSecret !== undefined) {
    data.webhookSecret = limits.webhookSecret
  }
  if (!Object.keys(data).length) return true
  const result = await prisma.apiKey.updateMany({ where: { id, userId, revoked: false }, data })
  return result.count > 0
}

export async function revokeApiKey(userId: string, id: string): Promise<boolean> {
  if (!hasDb || !prisma) return false
  const result = await prisma.apiKey.updateMany({
    where: { id, userId, revoked: false },
    data: { revoked: true },
  })
  return result.count > 0
}

export interface ResolvedKey {
  apiKeyId: string
  userId: string
  plan: string | null
  balanceMicros: bigint
  unlimited: boolean
}

/** Look up an active key by its plaintext value. */
export async function resolveApiKey(raw: string): Promise<ResolvedKey | null> {
  if (!hasDb || !prisma) return null
  const record = await prisma.apiKey.findUnique({
    where: { keyHash: hashKey(raw) },
    select: {
      id: true,
      revoked: true,
      user: { select: { id: true, apiPlan: true, apiBalanceMicros: true, unlimited: true } },
    },
  })
  if (!record || record.revoked || !record.user) return null
  return {
    apiKeyId: record.id,
    userId: record.user.id,
    plan: record.user.apiPlan,
    balanceMicros: record.user.apiBalanceMicros,
    unlimited: record.user.unlimited,
  }
}
