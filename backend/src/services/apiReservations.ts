import { createHash, randomUUID } from 'crypto'
import { Prisma } from '@prisma/client'
import { hasDb, prisma } from './prisma'

export const MAX_API_MICROS = BigInt(Number.MAX_SAFE_INTEGER)
export const MAX_API_COUNT = 2_147_483_647

export class ApiBillingError extends Error {
  constructor(public readonly code: 'invalid_amount' | 'invalid_request' | 'unavailable' | 'insufficient_quota' | 'conflict' | 'invalid_owner' | 'lease_lost' | 'settlement_exhausted') {
    super(`API accounting: ${code}`)
    this.name = 'ApiBillingError'
  }
}

export function apiAmount(value: number | bigint): bigint {
  if (typeof value !== 'bigint' && (typeof value !== 'number' || !Number.isSafeInteger(value))) throw new ApiBillingError('invalid_amount')
  const amount = BigInt(value)
  if (amount < 0n || amount > MAX_API_MICROS) throw new ApiBillingError('invalid_amount')
  return amount
}

export function apiCount(value: number = 0): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_API_COUNT) throw new ApiBillingError('invalid_amount')
  return value
}

export function apiIdentifier(value: string, max = 256): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new ApiBillingError('invalid_request')
  return value
}

/** Internal only: never derive a reservation identity from client headers/body. */
export const newApiReservationId = () => randomUUID()
export const apiFingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value, (_key, item) =>
  item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item,
)).digest('hex')

/** Retry only whole DB transactions; never include provider work in this callback. */
export async function apiTransaction<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  if (!hasDb || !prisma) throw new ApiBillingError('unavailable')
  for (let attempt = 0; ; attempt++) {
    try {
      return await prisma.$transaction(work, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 15_000 })
    } catch (error: any) {
      // Raw SELECT ... FOR UPDATE reports serialization/deadlock SQLSTATEs as
      // P2010 rather than P2034. Retry the entire transaction in either case.
      const retryable = ['P2034', 'P2002'].includes(error?.code) ||
        (error?.code === 'P2010' && ['40001', '40P01'].includes(error?.meta?.code))
      if (!retryable || attempt >= 7) throw error
      await new Promise(resolve => setTimeout(resolve, Math.min(10 * 2 ** attempt, 250) + Math.floor(Math.random() * 15)))
    }
  }
}

export interface ReservationOwner { id: string; userId: string; apiKeyId?: string | null }
export interface ReserveApiInput extends ReservationOwner {
  kind: 'chat' | 'embedding' | 'image' | 'video'
  model: string
  amountMicros: number | bigint
  /** Hash of server-normalized payload AND pricing snapshot, not raw client keys. */
  requestFingerprint: string
  /** Durable tariff/limits for later reconciliation; never include request text. */
  pricingSnapshot?: Record<string, string | number | null>
}

async function owned(tx: Prisma.TransactionClient, owner: ReservationOwner) {
  apiIdentifier(owner.id)
  apiIdentifier(owner.userId)
  // All reservation mutations use reservation -> intent -> balance lock order.
  await tx.$queryRaw`SELECT "id" FROM "ApiReservation" WHERE "id" = ${owner.id} FOR UPDATE`
  const row = await tx.apiReservation.findUnique({ where: { id: owner.id } })
  if (!row || row.userId !== owner.userId || row.apiKeyId !== (owner.apiKeyId ?? null)) throw new ApiBillingError('invalid_owner')
  return row
}

export async function reserveApiBalance(input: ReserveApiInput) {
  validateApiReserve(input)
  return apiTransaction(tx => reserveApiBalanceTx(tx, input))
}

function validateApiReserve(input: ReserveApiInput) {
  const amount = apiAmount(input.amountMicros)
  apiIdentifier(input.id)
  apiIdentifier(input.userId)
  apiIdentifier(input.model)
  if (!['chat', 'embedding', 'image', 'video'].includes(input.kind) || !/^[a-f0-9]{64}$/.test(input.requestFingerprint)) throw new ApiBillingError('invalid_request')
  if (input.pricingSnapshot) {
    if (Object.keys(input.pricingSnapshot).length > 32) throw new ApiBillingError('invalid_request')
    for (const [key, value] of Object.entries(input.pricingSnapshot)) {
      apiIdentifier(key)
      if (typeof value === 'number') apiAmount(value)
      else if (typeof value === 'string') apiIdentifier(value)
      else if (value !== null) throw new ApiBillingError('invalid_request')
    }
  }
  return amount
}

/** Internal composition boundary: caller owns the entire retryable DB transaction. */
export async function reserveApiBalanceTx(tx: Prisma.TransactionClient, input: ReserveApiInput) {
    const amount = validateApiReserve(input)
    const previous = await tx.apiReservation.findUnique({ where: { id: input.id } })
    if (previous) {
      if (previous.userId !== input.userId || previous.apiKeyId !== (input.apiKeyId ?? null) || previous.kind !== input.kind ||
          previous.model !== input.model || previous.amountMicros !== amount || previous.requestFingerprint !== input.requestFingerprint ||
          apiFingerprint(previous.pricingSnapshot) !== apiFingerprint(input.pricingSnapshot ?? null)) throw new ApiBillingError('conflict')
      return previous
    }
    if (input.apiKeyId) {
      const key = await tx.apiKey.findFirst({ where: { id: input.apiKeyId, userId: input.userId, revoked: false } })
      if (!key) throw new ApiBillingError('invalid_owner')
    } else if (input.apiKeyId === '') throw new ApiBillingError('invalid_owner')
    const changed = await tx.user.updateMany({
      where: { id: input.userId, apiBalanceMicros: { gte: amount } },
      data: { apiBalanceMicros: { decrement: amount } },
    })
    if (changed.count !== 1) throw new ApiBillingError('insufficient_quota')
    return tx.apiReservation.create({ data: {
      id: input.id, userId: input.userId, apiKeyId: input.apiKeyId ?? null,
      kind: input.kind, model: input.model, amountMicros: amount, requestFingerprint: input.requestFingerprint,
      ...(input.pricingSnapshot ? { pricingSnapshot: input.pricingSnapshot } : {}),
    } })
}

/** Exactly one caller may dispatch. Persist BEFORE invoking upstream. A crash
 * between this commit and invocation is deliberately reconciled as unknown. */
export async function dispatchApiReservation(owner: ReservationOwner): Promise<void> {
  await apiTransaction(async tx => {
    const row = await owned(tx, owner)
    if (row.state !== 'reserved') throw new ApiBillingError('conflict')
    await tx.apiReservation.update({ where: { id: row.id }, data: { state: 'dispatched' } })
  })
}

/** Unknown is NOT a refund. Retain the complete hold and evidence of any known
 * partial work. Operators reconcile unknown/stale dispatched rows using provider
 * records; settlement requires a durable evidence reference. No age-based release.
 * If this write fails, the persisted dispatched row still retains the hold. */
export async function markApiReservationUnknown(owner: ReservationOwner, completedUnits = 0): Promise<void> {
  apiCount(completedUnits)
  await apiTransaction(async tx => {
    const row = await owned(tx, owner)
    if (row.state === 'captured' || row.state === 'released') return
    if (row.state !== 'dispatched' && row.state !== 'unknown') throw new ApiBillingError('conflict')
    const prior = (row.evidence as { completedUnits?: number } | null)?.completedUnits ?? 0
    await tx.apiReservation.update({ where: { id: row.id }, data: {
      state: 'unknown', evidence: { reason: 'upstream_or_settlement_uncertain', completedUnits: Math.max(prior, completedUnits) },
    } })
  })
}

export interface ApiSettlement extends ReservationOwner {
  outcome: 'capture' | 'release'
  costMicros: number | bigint
  tokensIn?: number
  tokensOut?: number
  units?: number
  /** Mandatory to resolve unknown work or release a dispatched hold. */
  reconciliationReference?: string
  expectedKind?: string
  expectedModel?: string
}

/** Failure cleanup consults durable state, including ambiguous commit outcomes.
 * The route owns this identity exclusively; transition guards still forbid a
 * concurrent dispatch from turning this pre-work release into an unsafe refund. */
export async function abandonApiReservation(owner: ReservationOwner, completedUnits = 0): Promise<void> {
  const row = await apiTransaction(async tx => tx.apiReservation.findUnique({ where: { id: owner.id } }))
  if (!row) return
  if (row.userId !== owner.userId || row.apiKeyId !== (owner.apiKeyId ?? null)) throw new ApiBillingError('invalid_owner')
  if (row.state === 'reserved') {
    await settleApiReservation({ ...owner, outcome: 'release', costMicros: 0 })
  } else {
    await markApiReservationUnknown(owner, completedUnits)
  }
}

export async function settleApiReservation(input: ApiSettlement): Promise<number> {
  const values = validateApiSettlement(input)
  return apiTransaction(tx => settleApiReservationTx(tx, input, values))
}

function validateApiSettlement(input: ApiSettlement) {
  const cost = apiAmount(input.costMicros)
  const tokensIn = apiCount(input.tokensIn), tokensOut = apiCount(input.tokensOut), units = apiCount(input.units)
  if (!['capture', 'release'].includes(input.outcome)) throw new ApiBillingError('invalid_request')
  const reference = input.reconciliationReference === undefined ? null : apiIdentifier(input.reconciliationReference)
  if (input.outcome === 'release' && (cost !== 0n || tokensIn || tokensOut || units)) throw new ApiBillingError('invalid_amount')
  const fingerprint = apiFingerprint([input.outcome, cost.toString(), tokensIn, tokensOut, units, reference])
  return { cost, tokensIn, tokensOut, units, reference, fingerprint }
}

/** Low-level manual settlement keeps its original reference and replay semantics.
 * Recovery calls this within the transaction holding the reservation AND fence. */
export async function settleApiReservationTx(tx: Prisma.TransactionClient, input: ApiSettlement, values = validateApiSettlement(input)): Promise<number> {
  const { cost, tokensIn, tokensOut, units, reference, fingerprint } = values
  const row = await owned(tx, input)
  if ((input.expectedKind !== undefined && input.expectedKind !== row.kind) ||
      (input.expectedModel !== undefined && input.expectedModel !== row.model)) throw new ApiBillingError('conflict')
  if (row.state === 'captured' || row.state === 'released') {
    if (row.settlementFingerprint !== fingerprint) throw new ApiBillingError('conflict')
    return Number(row.capturedMicros)
  }
  if (cost > row.amountMicros) throw new ApiBillingError('invalid_amount')
  if ((row.state === 'unknown' || (input.outcome === 'release' && row.state === 'dispatched')) && !reference) throw new ApiBillingError('conflict')
  if (input.outcome === 'capture' && row.state === 'reserved') throw new ApiBillingError('conflict')
  const refund = row.amountMicros - cost
  const changed = await tx.user.updateMany({
    where: { id: row.userId, apiBalanceMicros: { gte: 0n, lte: MAX_API_MICROS - refund } },
    data: { apiBalanceMicros: { increment: refund } },
  })
  if (changed.count !== 1) throw new ApiBillingError('invalid_amount')
  await tx.apiUsage.create({ data: {
    reservationId: row.id, userId: row.userId, apiKeyId: row.apiKeyId,
    kind: row.kind, model: row.model, tokensIn, tokensOut, units, costMicros: cost,
  } })
  await tx.apiReservation.update({ where: { id: row.id }, data: {
    state: input.outcome === 'capture' ? 'captured' : 'released', capturedMicros: cost, settlementFingerprint: fingerprint,
    ...(reference ? { evidence: { reconciliationReference: reference, previous: row.evidence } as Prisma.InputJsonObject } : {}),
  } })
  if (row.apiKeyId) await tx.apiKey.update({ where: { id: row.apiKeyId }, data: { lastUsedAt: new Date() } })
  return Number(cost)
}

export const API_SETTLEMENT_MAX_ATTEMPTS = 10
export interface ApiSettlementClaim { reservationId: string; leaseToken: string }
/** Internal confirmed-usage boundary. Call only AFTER validated provider output or
 * completed server-metered work. Never construct from client-supplied usage/cost.
 * An omitted model is bound to the reservation's server-selected model. */
export interface ApiCaptureInput extends ReservationOwner {
  costMicros: number | bigint
  tokensIn?: number
  tokensOut?: number
  units?: number
  expectedKind: ReserveApiInput['kind']
  expectedModel?: string
}
type Intent = NonNullable<Awaited<ReturnType<Prisma.TransactionClient['apiSettlementIntent']['findUnique']>>>
type Reservation = NonNullable<Awaited<ReturnType<Prisma.TransactionClient['apiReservation']['findUnique']>>>
function confirmedFingerprint(input: ReservationOwner, kind: string, model: string, cost: bigint, tokensIn: number, tokensOut: number, units: number) {
  return apiFingerprint([1, input.id, input.userId, input.apiKeyId ?? null, kind, model, cost.toString(), tokensIn, tokensOut, units])
}
function captureFingerprint(cost: bigint, tokensIn: number, tokensOut: number, units: number, reference: string | null) {
  // Preserve the existing settlement representation, including legacy null references.
  return apiFingerprint(['capture', cost.toString(), tokensIn, tokensOut, units, reference])
}
function validateIntent(row: Reservation, intent: Intent) {
  const { costMicros, tokensIn, tokensOut, units } = intent
  apiAmount(costMicros); apiCount(tokensIn); apiCount(tokensOut); apiCount(units)
  if (row.id !== intent.reservationId || row.userId !== intent.userId || row.apiKeyId !== intent.apiKeyId ||
      row.kind !== intent.kind || row.model !== intent.model || costMicros > row.amountMicros ||
      intent.fingerprint !== confirmedFingerprint(row, intent.kind, intent.model, costMicros, tokensIn, tokensOut, units) ||
      intent.reconciliationReference !== `server:api-settlement:${intent.fingerprint}`) throw new ApiBillingError('conflict')
}
/** Also used to reconcile an ambiguous capture commit before recording failure. */
export function apiIntentMatchesCapture(row: Reservation, intent: Intent): boolean {
  try { validateIntent(row, intent) } catch { return false }
  return row.state === 'captured' && row.capturedMicros === intent.costMicros &&
    row.settlementFingerprint === captureFingerprint(intent.costMicros, intent.tokensIn, intent.tokensOut, intent.units, intent.reconciliationReference)
}

/** Persist immutable confirmed usage in its OWN transaction, before capture.
 * Null denotes an exact historical capture: leave its evidence/fingerprint alone. */
export async function enqueueApiSettlement(input: ApiCaptureInput): Promise<Intent | null> {
  validateApiCapture(input)
  return apiTransaction(tx => enqueueApiSettlementTx(tx, input))
}

function validateApiCapture(input: ApiCaptureInput) {
  const cost = apiAmount(input.costMicros)
  const tokensIn = apiCount(input.tokensIn), tokensOut = apiCount(input.tokensOut), units = apiCount(input.units)
  apiIdentifier(input.id); apiIdentifier(input.userId)
  if (input.apiKeyId != null) apiIdentifier(input.apiKeyId)
  if (!['chat', 'embedding', 'image', 'video'].includes(input.expectedKind)) throw new ApiBillingError('invalid_request')
  if (input.expectedModel !== undefined) apiIdentifier(input.expectedModel)
  return { cost, tokensIn, tokensOut, units }
}

/** Persist evidence with the caller's job fence, but in a commit BEFORE capture. */
export async function enqueueApiSettlementTx(tx: Prisma.TransactionClient, input: ApiCaptureInput): Promise<Intent | null> {
    const { cost, tokensIn, tokensOut, units } = validateApiCapture(input)
    const row = await owned(tx, input)
    apiIdentifier(row.model)
    if (row.kind !== input.expectedKind || (input.expectedModel !== undefined && row.model !== input.expectedModel)) throw new ApiBillingError('conflict')
    if (cost > row.amountMicros) throw new ApiBillingError('invalid_amount')
    const fingerprint = confirmedFingerprint(input, row.kind, row.model, cost, tokensIn, tokensOut, units)
    const previous = await tx.apiSettlementIntent.findUnique({ where: { reservationId: row.id } })
    if (previous) {
      validateIntent(row, previous)
      if (previous.fingerprint !== fingerprint) throw new ApiBillingError('conflict')
      return previous
    }
    if (row.state === 'captured' && row.capturedMicros === cost &&
        row.settlementFingerprint === captureFingerprint(cost, tokensIn, tokensOut, units, null)) return null
    if (!['dispatched', 'unknown'].includes(row.state)) throw new ApiBillingError('conflict')
    return tx.apiSettlementIntent.create({ data: {
      reservationId: row.id, userId: row.userId, apiKeyId: row.apiKeyId, kind: row.kind, model: row.model,
      costMicros: cost, tokensIn, tokensOut, units, fingerprint, reconciliationReference: `server:api-settlement:${fingerprint}`,
    } })
}

/** Only committed confirmed usage can resolve dispatched/unknown work. The DB
 * clock fence is checked after BOTH locks, and held through the capture commit. */
export async function captureApiSettlement(id: string, claim?: ApiSettlementClaim): Promise<number> {
  apiIdentifier(id)
  return apiTransaction(tx => captureApiSettlementTx(tx, id, claim))
}

/** Caller may additionally hold a durable job fence through this capture. */
export async function captureApiSettlementTx(tx: Prisma.TransactionClient, id: string, claim?: ApiSettlementClaim): Promise<number> {
  apiIdentifier(id)
    await tx.$queryRaw`SELECT "id" FROM "ApiReservation" WHERE "id" = ${id} FOR UPDATE`
    const row = await tx.apiReservation.findUnique({ where: { id } })
    if (!row) throw new ApiBillingError('invalid_owner')
    await tx.$queryRaw`SELECT "reservationId" FROM "ApiSettlementIntent" WHERE "reservationId" = ${id} FOR UPDATE`
    const intent = await tx.apiSettlementIntent.findUnique({ where: { reservationId: id } })
    if (!intent) throw new ApiBillingError('conflict')
    if (claim) {
      const valid = await tx.$queryRaw<{ reservationId: string }[]>`SELECT "reservationId" FROM "ApiSettlementIntent"
        WHERE "reservationId" = ${id} AND "reservationId" = ${claim.reservationId} AND "status" = 'processing'
          AND "leaseToken" = ${claim.leaseToken} AND "leaseExpiresAt" > clock_timestamp()`
      if (!valid.length) throw new ApiBillingError('lease_lost')
    }
    validateIntent(row, intent)
    if (!apiIntentMatchesCapture(row, intent)) {
      if (!['pending', 'processing'].includes(intent.status) || !['dispatched', 'unknown'].includes(row.state)) throw new ApiBillingError('conflict')
      if (claim && intent.attempts > API_SETTLEMENT_MAX_ATTEMPTS) throw new ApiBillingError('settlement_exhausted')
    }
    const cost = await settleApiReservationTx(tx, {
      id, userId: intent.userId, apiKeyId: intent.apiKeyId, outcome: 'capture', costMicros: intent.costMicros,
      tokensIn: intent.tokensIn, tokensOut: intent.tokensOut, units: intent.units,
      expectedKind: intent.kind, expectedModel: intent.model, reconciliationReference: intent.reconciliationReference,
    })
    // Foreground success retires competing leases atomically. Workers acknowledge
    // separately, so a failed acknowledgement replays only the exact capture.
    if (!claim && ['pending', 'processing'].includes(intent.status)) {
      await tx.apiSettlementIntent.update({ where: { reservationId: id }, data: {
        status: 'succeeded', lastErrorCode: null, leaseToken: null, leaseExpiresAt: null,
      } })
    }
    return cost
}

export async function captureApiReservation(input: ApiCaptureInput): Promise<number> {
  const intent = await enqueueApiSettlement(input)
  if (!intent) return settleApiReservation({ ...input, outcome: 'capture' })
  return captureApiSettlement(input.id)
}
