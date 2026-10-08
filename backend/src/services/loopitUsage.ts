/**
 * Meter Loop-IT usage onto the workspace owner's Loop-GPT credit ledger.
 * The org id comes from the verified LOOPIT-ID token. Stripe stays on the
 * Loop-GPT side; this path never calls Stripe.
 */
import { createHash } from 'crypto'
import { prisma, hasDb } from './prisma'
import { recordLoopitMeteredUsage } from './dailyReservations'

export const LOOPIT_METER_KINDS = [
  'inference',
  'sandbox_seconds',
  'storage',
  'hosting_seconds',
  'custom_domain_months',
  'domain_registration',
] as const

export type LoopitMeterKind = (typeof LOOPIT_METER_KINDS)[number]

export class LoopitUsageError extends Error {
  constructor(public status: number, message: string) {
    super(message)
    this.name = 'LoopitUsageError'
  }
}

export interface LoopitUsageEvent {
  idempotencyKey: string
  kind: LoopitMeterKind
  model?: string
  inputTokens: number
  outputTokens: number
  cachedInputTokens: number
  sandboxSeconds: number
  hostingSeconds: number
  storageGbMonths: number
  customDomainMonths: number
  runId?: string
}

export interface LoopitUsageResult {
  reservationId: string
  credits: number
  duplicate: boolean
  ownerId: string
}

function sha256(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function whole(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new LoopitUsageError(400, `Invalid ${label}`)
  return value
}

/** Credits scale with the meter. One credit is 1k tokens or one sandbox minute. */
export function loopitMeterCredits(event: LoopitUsageEvent): number {
  let credits = 0
  switch (event.kind) {
    case 'inference': {
      const tokens = whole(event.inputTokens, 'inputTokens') + whole(event.outputTokens, 'outputTokens') + whole(event.cachedInputTokens, 'cachedInputTokens')
      if (tokens <= 0) throw new LoopitUsageError(400, 'Inference usage requires tokens')
      credits = Math.ceil(tokens / 1000)
      break
    }
    case 'sandbox_seconds': {
      const seconds = whole(event.sandboxSeconds, 'sandboxSeconds')
      if (seconds <= 0) throw new LoopitUsageError(400, 'Sandbox usage requires seconds')
      credits = Math.ceil(seconds / 60)
      break
    }
    case 'hosting_seconds': {
      const seconds = whole(event.hostingSeconds, 'hostingSeconds')
      if (seconds <= 0) throw new LoopitUsageError(400, 'Hosting usage requires seconds')
      credits = Math.ceil(seconds / 3600)
      break
    }
    case 'storage': {
      if (!Number.isFinite(event.storageGbMonths) || event.storageGbMonths <= 0) {
        throw new LoopitUsageError(400, 'Storage usage requires a positive amount')
      }
      credits = Math.ceil(event.storageGbMonths)
      break
    }
    case 'custom_domain_months': {
      if (!Number.isFinite(event.customDomainMonths) || event.customDomainMonths <= 0) {
        throw new LoopitUsageError(400, 'Domain usage requires a positive amount')
      }
      credits = Math.ceil(event.customDomainMonths)
      break
    }
    case 'domain_registration':
      credits = 1
      break
    default: {
      const unexpected: never = event.kind
      throw new LoopitUsageError(400, `Invalid usage kind ${String(unexpected)}`)
    }
  }
  if (!Number.isSafeInteger(credits) || credits < 1 || credits > 10_000) {
    throw new LoopitUsageError(400, 'Usage charge is out of range')
  }
  return credits
}

export function loopitUsageFingerprints(workspaceId: string, event: LoopitUsageEvent, credits: number) {
  return {
    requestFingerprint: sha256(['loopit-usage', 1, workspaceId, event.idempotencyKey]),
    payloadFingerprint: sha256([
      'loopit-usage-payload', 1, workspaceId, event.idempotencyKey, event.kind, event.model ?? '',
      event.inputTokens, event.outputTokens, event.cachedInputTokens, event.sandboxSeconds,
      event.hostingSeconds, event.storageGbMonths, event.customDomainMonths, event.runId ?? '', credits,
    ]),
  }
}

/** Personal workspace owner, otherwise the earliest owner membership. */
export async function resolveWorkspaceBillingOwner(workspaceId: string): Promise<{ ownerId: string } | { error: 'missing' | 'no_owner' }> {
  if (!hasDb || !prisma) throw new LoopitUsageError(503, 'Usage recording is temporarily unavailable')
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: {
      personalOwnerId: true,
      members: { where: { role: 'owner' }, orderBy: { createdAt: 'asc' }, take: 1, select: { userId: true } },
    },
  })
  if (!workspace) return { error: 'missing' }
  const ownerId = workspace.personalOwnerId ?? workspace.members[0]?.userId
  if (!ownerId) return { error: 'no_owner' }
  return { ownerId }
}

export async function recordLoopitUsage(workspaceId: string, event: LoopitUsageEvent): Promise<LoopitUsageResult> {
  if (event.kind === 'inference' && !event.model) throw new LoopitUsageError(400, 'Inference usage requires a model')
  const owner = await resolveWorkspaceBillingOwner(workspaceId)
  if ('error' in owner) {
    throw new LoopitUsageError(owner.error === 'missing' ? 404 : 409, owner.error === 'missing' ? 'Workspace not found' : 'Workspace has no billing owner')
  }
  const credits = loopitMeterCredits(event)
  const fingerprints = loopitUsageFingerprints(workspaceId, event, credits)
  const recorded = await recordLoopitMeteredUsage({
    userId: owner.ownerId,
    ...fingerprints,
    model: event.model || event.kind,
    tokensIn: event.inputTokens + event.cachedInputTokens,
    tokensOut: event.outputTokens,
    credits,
    pricingSnapshot: {
      source: 'loopit',
      workspaceId,
      meterKind: event.kind,
      runId: event.runId ?? null,
      sandboxSeconds: event.sandboxSeconds,
      hostingSeconds: event.hostingSeconds,
      storageGbMonths: event.storageGbMonths,
      customDomainMonths: event.customDomainMonths,
    },
  })
  return { ...recorded, ownerId: owner.ownerId }
}
