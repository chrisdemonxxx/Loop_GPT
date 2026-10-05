/**
 * Bot task queue integration: lease claim, guarded acks, retry/dead-letter
 * backoff, scheduled requeue, operator cancel, and lease heartbeat — against
 * the dedicated loop_foundation_test database (requires the bot_tasks
 * migration applied, same contract as the settlement suites).
 */
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { prisma } from '../prisma'
import {
  cancelAgentTask,
  claimAgentTasks,
  completeAgentTask,
  enqueueAgentTask,
  failAgentTask,
  isCancelRequested,
  parseScheduleMs,
  renewAgentTaskLease,
  AGENT_TASK_MAX_ATTEMPTS,
} from '../agentTasks'

const db = prisma!
const prefix = `bottask-${randomUUID()}`
let creatorId: string
const LEASE_MS = 60_000

async function enqueue(overrides: Record<string, unknown> = {}) {
  return enqueueAgentTask({ goal: `goal-${randomUUID()}`, ...overrides } as any, creatorId)
}
async function raw(id: string) {
  return db.agentTask.findUniqueOrThrow({ where: { id } })
}
async function expire(id: string) {
  await db.$executeRaw`UPDATE "AgentTask" SET "leaseExpiresAt" = clock_timestamp() - interval '1 second' WHERE "id" = ${id}`
}
async function due(id: string) {
  await db.$executeRaw`UPDATE "AgentTask" SET "nextAttemptAt" = clock_timestamp() - interval '1 second' WHERE "id" = ${id}`
}
async function claimOne() {
  const claims = await claimAgentTasks({ batchSize: 1, leaseMs: LEASE_MS })
  expect(claims).toHaveLength(1)
  return claims[0]
}

beforeEach(async () => {
  creatorId = `${prefix}-${randomUUID()}`
  await db.user.create({ data: { id: creatorId, email: `${creatorId}@example.test`, password: 'fixture', name: 'Fixture' } })
})

afterEach(async () => {
  await db.botRun.deleteMany({ where: { task: { createdBy: { startsWith: prefix } } } })
  await db.agentTask.deleteMany({ where: { createdBy: { startsWith: prefix } } })
  await db.user.deleteMany({ where: { id: { startsWith: prefix } } })
})

describe('enqueue + claim', () => {
  it('claims a due queued task with a DB-clock lease', async () => {
    const task = await enqueue()
    const claims = await claimAgentTasks({ batchSize: 1, leaseMs: LEASE_MS })
    expect(claims).toHaveLength(1)
    expect(claims[0].taskId).toBe(task.id)
    const row = await raw(task.id)
    expect(row.status).toBe('processing')
    expect(row.leaseToken).toBe(claims[0].leaseToken)
    expect(row.leaseExpiresAt!.getTime()).toBeGreaterThan(Date.now() + LEASE_MS - 10_000)
    expect(row.attempts).toBe(1)
  })

  it('does not claim future or processing tasks until the lease expires', async () => {
    await enqueue()
    await claimOne()
    expect(await claimAgentTasks({ batchSize: 1, leaseMs: LEASE_MS })).toHaveLength(0)
  })

  it('re-claims after lease expiry (worker crash replay)', async () => {
    const task = await enqueue()
    await claimOne()
    await expire(task.id)
    const reclaim = await claimOne()
    expect(reclaim.taskId).toBe(task.id)
    expect((await raw(task.id)).attempts).toBe(2)
  })

  it('honours priority ordering', async () => {
    const low = await enqueue({ priority: 0 })
    const high = await enqueue({ priority: 10 })
    const claims = await claimAgentTasks({ batchSize: 1, leaseMs: LEASE_MS })
    expect(claims[0].taskId).toBe(high.id)
    expect((await raw(low.id)).status).toBe('queued')
  })

  it('rejects an ops task carrying a schedule and unknown tool names', async () => {
    await expect(enqueue({ schedule: '6h' })).rejects.toMatchObject({ code: 'invalid_request' })
    await expect(enqueue({ kind: 'scheduled' })).rejects.toMatchObject({ code: 'invalid_request' })
    await expect(enqueue({ allowedTools: ['not_a_tool'] })).rejects.toMatchObject({ code: 'invalid_request' })
  })
})

describe('complete / fail', () => {
  it('success ack retires a one-shot task', async () => {
    const task = await enqueue()
    const claim = await claimOne()
    expect(await completeAgentTask(claim)).toBe('succeeded')
    const row = await raw(task.id)
    expect(row.status).toBe('succeeded')
    expect(row.leaseToken).toBeNull()
  })

  it('guarded ack fails after lease loss', async () => {
    const task = await enqueue()
    const claim = await claimOne()
    await expire(task.id)
    expect(await completeAgentTask(claim)).toBe('lease_lost')
    expect(await failAgentTask(claim, 'BOT_RUN_FAILED', 'x')).toBe('lease_lost')
  })

  it('failure retries with backoff, then dead-letters at max attempts', async () => {
    const task = await enqueue()
    // attempt 1 → retry; attempt 2 → retry; attempt 3 → dead_letter
    const first = await claimOne()
    expect(await failAgentTask(first, 'BOT_RUN_FAILED', 'boom')).toBe('retry')
    let row = await raw(task.id)
    expect(row.status).toBe('queued')
    expect(row.failures).toBe(1)
    expect(row.lastErrorCode).toBe('BOT_RUN_FAILED')
    expect(row.nextAttemptAt.getTime()).toBeGreaterThan(Date.now())

    await due(task.id)
    const second = await claimOne()
    expect(second.taskId).toBe(task.id)
    expect(await failAgentTask(second, 'BOT_RUN_FAILED', 'boom')).toBe('retry')

    await due(task.id)
    const third = await claimOne()
    expect(third.taskId).toBe(task.id)
    expect((await raw(task.id)).attempts).toBe(AGENT_TASK_MAX_ATTEMPTS)
    expect(await failAgentTask(third, 'BOT_RUN_FAILED', 'boom')).toBe('dead_letter')
    row = await raw(task.id)
    expect(row.status).toBe('dead_letter')
    expect(row.leaseToken).toBeNull()
  })

  it('a scheduled task requeues at DB clock + interval and resets attempts', async () => {
    const task = await enqueue({ kind: 'scheduled', schedule: '5m' })
    const claim = await claimOne()
    expect(await completeAgentTask(claim)).toBe('succeeded')
    const row = await raw(task.id)
    expect(row.status).toBe('queued')
    expect(row.attempts).toBe(0)
    expect(row.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() + parseScheduleMs('5m') - 15_000)
    expect(row.nextAttemptAt.getTime()).toBeLessThan(Date.now() + parseScheduleMs('5m') + 15_000)
  })
})

describe('heartbeat + cancel', () => {
  it('renews a live lease and refuses a lost one', async () => {
    const task = await enqueue()
    const claim = await claimOne()
    const before = (await raw(task.id)).leaseExpiresAt!.getTime()
    await new Promise((resolve) => setTimeout(resolve, 1100))
    expect(await renewAgentTaskLease(claim, LEASE_MS)).toBe(true)
    const after = (await raw(task.id)).leaseExpiresAt!.getTime()
    expect(after).toBeGreaterThan(before)
    await expire(task.id)
    expect(await renewAgentTaskLease(claim, LEASE_MS)).toBe(false)
  })

  it('immediate-cancel retires queued; running tasks get the flag the heartbeat reads', async () => {
    const queuedTask = await enqueue()
    const queuedCancel = await cancelAgentTask(queuedTask.id)
    expect(queuedCancel).toEqual({ cancelled: true, immediate: true })
    expect((await raw(queuedTask.id)).status).toBe('cancelled')

    const running = await enqueue()
    const claim = await claimOne()
    const runningCancel = await cancelAgentTask(running.id)
    expect(runningCancel).toEqual({ cancelled: true, immediate: false })
    expect(await isCancelRequested(running.id)).toBe(true)
    expect(await failAgentTask(claim, 'BOT_TASK_CANCELLED', 'Cancelled by operator')).toBe('cancelled')
    const row = await raw(running.id)
    expect(row.status).toBe('cancelled')
    expect(row.failures).toBe(0)
    expect(row.cancelRequested).toBe(false)
  })

  it('refuses to cancel finished or nonexistent tasks', async () => {
    await expect(cancelAgentTask(`${prefix}-missing`)).rejects.toMatchObject({ code: 'conflict' })
    const task = await enqueue()
    const claim = await claimOne()
    await completeAgentTask(claim)
    await expect(cancelAgentTask(task.id)).rejects.toMatchObject({ code: 'conflict' })
  })
})
