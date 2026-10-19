/**
 * Unified Workspace Wallet (Tier 2-1).
 *
 * Bridges User/Workspace billing into two USD credit buckets:
 *   1. `subCreditsMicros` — monthly subscription credit allowance that expires at
 *      `subCreditsExpireAt` (end of billing cycle) and is spent FIRST.
 *   2. `apiBalanceMicros` / `walletMicros` — rollover prepaid/top-up/IAP balance
 *      that never expires and is spent AFTER subscription credits are exhausted.
 *
 * Also supports workspace-level member spend caps (`WorkspaceMember.spendCapMicros`).
 */
import { prisma, hasDb } from './prisma'
import { ensurePersonalWorkspace, requireMembership, workspaceDb, WorkspaceError } from './workspaces'
import { MICROS_PER_USD } from './apiBilling'

export const PLAN_MONTHLY_SUB_CREDITS_MICROS: Record<string, bigint> = {
  free: 0n,
  pro: BigInt(20 * MICROS_PER_USD),   // $20/mo subscription credit allowance
  max: BigInt(100 * MICROS_PER_USD),  // $100/mo subscription credit allowance
  gold: BigInt(100 * MICROS_PER_USD), // Legacy gold tier
  scale: BigInt(150 * MICROS_PER_USD),
}

export interface WalletOverview {
  workspaceId: string
  ownerUserId: string
  plan: string
  /** Active (non-expired) subscription credits in micro-USD (spent first). */
  subCreditsMicros: bigint
  subCreditsUsd: number
  subCreditsExpireAt: string | null
  /** Rollover prepaid/top-up credits in micro-USD (never expire). */
  rolloverMicros: bigint
  rolloverUsd: number
  /** Combined spendable balance in micro-USD (`subCreditsMicros + rolloverMicros`). */
  totalAvailableMicros: bigint
  totalAvailableUsd: number
}

export function activeSubCredits(subCreditsMicros: bigint | null | undefined, expireAt: Date | null | undefined, now = new Date()): bigint {
  const raw = subCreditsMicros ?? 0n
  if (raw <= 0n) return 0n
  if (expireAt && expireAt.getTime() <= now.getTime()) return 0n
  return raw
}

/**
 * Compute how a debit of `amountMicros` is split between expiring subscription
 * credits (spent first) and rollover balance (spent second).
 */
export function splitWalletDebit(params: {
  amountMicros: bigint
  subCreditsMicros: bigint
  subCreditsExpireAt: Date | null
  rolloverMicros: bigint
  now?: Date
}): { ok: boolean; fromSubMicros: bigint; fromRolloverMicros: bigint; remainingSubMicros: bigint; remainingRolloverMicros: bigint } {
  const activeSub = activeSubCredits(params.subCreditsMicros, params.subCreditsExpireAt, params.now)
  const rollover = params.rolloverMicros > 0n ? params.rolloverMicros : 0n
  const total = activeSub + rollover
  if (params.amountMicros > total) {
    return {
      ok: false,
      fromSubMicros: 0n,
      fromRolloverMicros: 0n,
      remainingSubMicros: activeSub,
      remainingRolloverMicros: rollover,
    }
  }
  const fromSubMicros = params.amountMicros <= activeSub ? params.amountMicros : activeSub
  const fromRolloverMicros = params.amountMicros - fromSubMicros
  return {
    ok: true,
    fromSubMicros,
    fromRolloverMicros,
    remainingSubMicros: activeSub - fromSubMicros,
    remainingRolloverMicros: rollover - fromRolloverMicros,
  }
}

/**
 * Grant or refresh monthly subscription credits for a user and their personal
 * workspace. Old subscription credits do NOT roll over; they are replaced by the
 * new cycle's allowance with the new `expireAt` timestamp.
 */
export async function grantSubscriptionCredits(
  userId: string,
  plan: string,
  expireAt: Date = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
): Promise<{ subCreditsMicros: bigint; expireAt: Date }> {
  const subCreditsMicros = PLAN_MONTHLY_SUB_CREDITS_MICROS[plan] ?? 0n
  if (!hasDb || !prisma) return { subCreditsMicros, expireAt }

  await prisma.user.update({
    where: { id: userId },
    data: {
      subCreditsMicros,
      subCreditsExpireAt: expireAt,
    },
  })

  await prisma.workspace.updateMany({
    where: { personalOwnerId: userId },
    data: {
      plan,
      subCreditsMicros,
      subCreditsExpireAt: expireAt,
    },
  })

  return { subCreditsMicros, expireAt }
}

/**
 * Inspect the unified wallet for a workspace (or the caller's personal workspace
 * when `workspaceId` is omitted).
 */
export async function getWorkspaceWallet(actorUserId: string, workspaceId?: string): Promise<WalletOverview> {
  if (!hasDb || !prisma) throw new WorkspaceError(503, 'Workspaces require a database')

  const ws = workspaceId
    ? await (async () => {
        await requireMembership(actorUserId, workspaceId, 'viewer')
        const found = await prisma!.workspace.findUnique({ where: { id: workspaceId } })
        if (!found) throw new WorkspaceError(404, 'Workspace not found')
        return found
      })()
    : await ensurePersonalWorkspace(actorUserId)

  const ownerUserId = ws.personalOwnerId || actorUserId
  const owner = await prisma.user.findUnique({
    where: { id: ownerUserId },
    select: {
      plan: true,
      apiBalanceMicros: true,
      subCreditsMicros: true,
      subCreditsExpireAt: true,
    },
  })

  const subCreditsMicros = activeSubCredits(
    owner ? owner.subCreditsMicros : ws.subCreditsMicros,
    owner ? owner.subCreditsExpireAt : ws.subCreditsExpireAt,
  )
  const rolloverMicros = (owner?.apiBalanceMicros ?? 0n) + (ws.personalOwnerId ? 0n : ws.walletMicros)
  const totalAvailableMicros = subCreditsMicros + rolloverMicros
  const expireAt = owner?.subCreditsExpireAt ?? ws.subCreditsExpireAt

  return {
    workspaceId: ws.id,
    ownerUserId,
    plan: owner?.plan || ws.plan || 'free',
    subCreditsMicros,
    subCreditsUsd: Number(subCreditsMicros) / MICROS_PER_USD,
    subCreditsExpireAt: expireAt ? expireAt.toISOString() : null,
    rolloverMicros,
    rolloverUsd: Number(rolloverMicros) / MICROS_PER_USD,
    totalAvailableMicros,
    totalAvailableUsd: Number(totalAvailableMicros) / MICROS_PER_USD,
  }
}

/**
 * Set or clear a per-member rolling 30-day spend cap on a workspace (owner only).
 */
export async function setWorkspaceMemberSpendCap(
  actorUserId: string,
  workspaceId: string,
  targetUserId: string,
  spendCapUsd: number | null,
): Promise<{ ok: boolean; spendCapUsd: number | null }> {
  await requireMembership(actorUserId, workspaceId, 'owner')
  const db = workspaceDb()
  const member = await db.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId: targetUserId } },
  })
  if (!member) throw new WorkspaceError(404, 'Member not found')

  const spendCapMicros = spendCapUsd == null ? null : BigInt(Math.round(spendCapUsd * MICROS_PER_USD))
  await db.workspaceMember.update({
    where: { workspaceId_userId: { workspaceId, userId: targetUserId } },
    data: { spendCapMicros },
  })
  return { ok: true, spendCapUsd }
}
