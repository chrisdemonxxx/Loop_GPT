/**
 * B3/B4 integration: per-user run identity (Loop Bot conversation in the
 * owner's personal workspace) and the reservation lifecycle for kind 'bot'
 * (reserve → dispatch → capture / cleanup-refund), against loop_foundation_test.
 */
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { prisma } from '../prisma'
import { ensureBotIdentity, ensureRunIdentity, resetBotIdentityCache } from '../botRunner'
import {
  captureDailyReservation,
  cleanupDailyReservation,
  dailyDispatch,
  reserveDailyCredits,
} from '../dailyReservations'

const db = prisma!
const prefix = `botrunner-${randomUUID()}`
let userId: string

beforeEach(async () => {
  resetBotIdentityCache()
  userId = `${prefix}-${randomUUID()}`
  await db.user.create({ data: { id: userId, email: `${userId}@example.test`, password: 'fixture', name: 'Owner' } })
})

afterEach(async () => {
  await db.usageEvent.deleteMany({ where: { userId: { startsWith: prefix } } })
  await db.dailySettlementIntent.deleteMany({ where: { userId: { startsWith: prefix } } })
  await db.dailyReservation.deleteMany({ where: { userId: { startsWith: prefix } } })
  await db.conversation.deleteMany({ where: { user: { id: { startsWith: prefix } } } })
  await db.conversation.deleteMany({ where: { user: { email: 'ops-bot@loop-gpt.cyou' } } })
  await db.user.deleteMany({ where: { email: 'ops-bot@loop-gpt.cyou' } })
  await db.user.deleteMany({ where: { id: { startsWith: prefix } } })
})

describe('ensureRunIdentity (B3)', () => {
  it('user-owned tasks get the owner account, personal workspace and a "Loop Bot" conversation', async () => {
    const identity = await ensureRunIdentity({ userId })
    expect(identity.userId).toBe(userId)
    const conversation = await db.conversation.findUniqueOrThrow({ where: { id: identity.conversationId } })
    expect(conversation.title).toBe('Loop Bot')
    expect(conversation.userId).toBe(userId)
    const workspace = await db.workspace.findUniqueOrThrow({ where: { id: identity.workspaceId } })
    expect(workspace.personalOwnerId).toBe(userId)

    // Idempotent: second run reuses the same conversation.
    const again = await ensureRunIdentity({ userId })
    expect(again.conversationId).toBe(identity.conversationId)
  })

  it('system tasks (no owner) keep the service account "Ops Bot" identity', async () => {
    const identity = await ensureRunIdentity({ userId: null })
    const botUser = await db.user.findUniqueOrThrow({ where: { id: identity.userId } })
    expect(botUser.email).toBe('ops-bot@loop-gpt.cyou')
    const conversation = await db.conversation.findUniqueOrThrow({ where: { id: identity.conversationId } })
    expect(conversation.title).toBe('Ops Bot')
    expect(identity.userId).not.toBe(userId)
  })
})

describe('bot reservation lifecycle (B4)', () => {
  it('reserve → dispatch → capture settles tokens and the flat bot hold', async () => {
    const before = await db.user.findUniqueOrThrow({ where: { id: userId } })
    const reservation = await reserveDailyCredits(userId, 'bot', 'fake-model')
    const afterReserve = await db.user.findUniqueOrThrow({ where: { id: userId } })
    expect(before.credits - afterReserve.credits).toBe(2) // CREDIT_COST.bot

    await dailyDispatch(reservation.id)()
    await captureDailyReservation(reservation.id, userId, 'bot', { tokensIn: 100, tokensOut: 40, model: 'fake-model' })

    const settled = await db.dailyReservation.findUniqueOrThrow({ where: { id: reservation.id } })
    expect(settled.state).toBe('captured')
    const event = await db.usageEvent.findFirstOrThrow({ where: { reservationId: reservation.id } })
    expect(event).toMatchObject({ kind: 'bot', tokensIn: 100, tokensOut: 40, credits: 2 })
    const final = await db.user.findUniqueOrThrow({ where: { id: userId } })
    expect(final.tokensInTotal - before.tokensInTotal).toBe(BigInt(100))
    expect(final.tokensOutTotal - before.tokensOutTotal).toBe(BigInt(40))
  })

  it('cleanup before dispatch releases the hold back to the user', async () => {
    const before = await db.user.findUniqueOrThrow({ where: { id: userId } })
    const reservation = await reserveDailyCredits(userId, 'bot', 'fake-model')
    await cleanupDailyReservation(reservation.id)
    const settled = await db.dailyReservation.findUniqueOrThrow({ where: { id: reservation.id } })
    expect(settled.state).toBe('released')
    const after = await db.user.findUniqueOrThrow({ where: { id: userId } })
    expect(after.credits).toBe(before.credits)
  })

  it('cleanup after dispatch marks unknown (no post-dispatch refund)', async () => {
    const before = await db.user.findUniqueOrThrow({ where: { id: userId } })
    const reservation = await reserveDailyCredits(userId, 'bot', 'fake-model')
    await dailyDispatch(reservation.id)()
    await cleanupDailyReservation(reservation.id)
    const settled = await db.dailyReservation.findUniqueOrThrow({ where: { id: reservation.id } })
    expect(settled.state).toBe('unknown')
    const after = await db.user.findUniqueOrThrow({ where: { id: userId } })
    expect(before.credits - after.credits).toBe(2)
  })
})
