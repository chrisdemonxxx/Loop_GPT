/**
 * Bot task queue integration: lease claim, guarded acks, retry/dead-letter
 * backoff, scheduled requeue, operator cancel, and lease heartbeat â€” against
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
  getAgentTask,
  isCancelRequested,
  listAgentTasks,
  parseScheduleMs,
  remainingVmMinutes,
  renewAgentTaskLease,
  AGENT_TASK_MAX_ATTEMPTS,
  BOT_VM_MINUTES_PER_DAY,
} from '../agentTasks'

const db = prisma!
process.env.E2B_API_KEY ||= 'integration-test-key'
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
    // attempt 1 â†’ retry; attempt 2 â†’ retry; attempt 3 â†’ dead_letter
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

  it('permanent failure codes dead-letter on the FIRST attempt (no retries)', async () => {
    for (const code of ['BOT_TASK_INVALID', 'BOT_COMPUTER_UNCONFIGURED', 'BOT_OUT_OF_CREDITS']) {
      const task = await enqueue()
      const claim = await claimOne()
      expect((await raw(task.id)).attempts).toBe(1)
      expect(await failAgentTask(claim, code, 'permanent condition')).toBe('dead_letter')
      const row = await raw(task.id)
      expect(row.status, code).toBe('dead_letter')
      expect(row.failures, code).toBe(1)
      expect(row.lastErrorCode).toBe(code)
    }
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

// â”€â”€ B1: ownership scoping â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

describe('ownership scoping (B1)', () => {
  let ownerId: string
  let strangerId: string

  beforeEach(async () => {
    ownerId = `${prefix}-owner-${randomUUID()}`
    strangerId = `${prefix}-stranger-${randomUUID()}`
    await db.user.create({ data: { id: ownerId, email: `${ownerId}@example.test`, password: 'f', name: 'Owner' } })
    await db.user.create({ data: { id: strangerId, email: `${strangerId}@example.test`, password: 'f', name: 'Stranger' } })
  })

  it('a user only lists, reads and cancels their own tasks', async () => {
    const mine = await enqueueAgentTask({ goal: 'mine' } as any, ownerId, ownerId)
    await enqueueAgentTask({ goal: 'system task' } as any, creatorId) // NULL owner

    const mineList = await listAgentTasks({ scope: { userId: ownerId } })
    expect(mineList.map((t) => t.id)).toEqual([mine.id])
    expect(await listAgentTasks({ scope: { userId: strangerId } })).toHaveLength(0)

    await expect(getAgentTask(mine.id, { userId: strangerId })).rejects.toMatchObject({ code: 'not_found' })
    await expect(cancelAgentTask(mine.id, { userId: strangerId })).rejects.toMatchObject({ code: 'conflict' })
    expect((await raw(mine.id)).status).toBe('queued') // stranger's cancel touched nothing

    const ownCancel = await cancelAgentTask(mine.id, { userId: ownerId })
    expect(ownCancel.cancelled).toBe(true)
    // Admins (no scope) still see and cancel everything.
    const all = await listAgentTasks()
    expect(all.length).toBeGreaterThanOrEqual(2)
  })

  it('user-enqueued tasks record the owner; admin-enqueued stay system tasks', async () => {
    const userTask = await enqueueAgentTask({ goal: 'user task' } as any, ownerId, ownerId)
    const sysTask = await enqueueAgentTask({ goal: 'system task' } as any, creatorId)
    expect((await raw(userTask.id)).userId).toBe(ownerId)
    expect((await raw(sysTask.id)).userId).toBeNull()
  })
})

// â”€â”€ B5: per-user concurrency guard â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

describe('per-user concurrency guard (B5)', () => {
  let userA: string
  let userB: string

  beforeEach(async () => {
    userA = `${prefix}-a-${randomUUID()}`
    userB = `${prefix}-b-${randomUUID()}`
    await db.user.create({ data: { id: userA, email: `${userA}@example.test`, password: 'f', name: 'A' } })
    await db.user.create({ data: { id: userB, email: `${userB}@example.test`, password: 'f', name: 'B' } })
  })

  it('never claims a second task for a user with one already processing', async () => {
    const first = await enqueueAgentTask({ goal: 'A first' } as any, userA, userA)
    const second = await enqueueAgentTask({ goal: 'A second' } as any, userA, userA)
    const other = await enqueueAgentTask({ goal: 'B task' } as any, userB, userB)
    const claim1 = await claimOne()
    expect(claim1.taskId).toBe(first.id)

    // A's second task is blocked while A's first is processing; B is not.
    const claim2 = await claimOne()
    expect(claim2.taskId).toBe(other.id)
    expect((await raw(second.id)).status).toBe('queued')

    // After A's first completes, A's second becomes claimable.
    await completeAgentTask(claim1)
    const claim3 = await claimOne()
    expect(claim3.taskId).toBe(second.id)
  })

  it('system tasks (NULL owner) never participate in the guard', async () => {
    await enqueueAgentTask({ goal: 'sys 1' } as any, creatorId)
    await enqueueAgentTask({ goal: 'sys 2' } as any, creatorId)
    const first = await claimOne()
    const second = await claimOne()
    expect(first.taskId).not.toBe(second.taskId)
  })
})

// â”€â”€ B4: VM-minute budgets â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

describe('VM-minute budgets (B4)', () => {
  async function makeUser(plan: string, opts: { unlimited?: boolean; role?: string } = {}) {
    const id = `${prefix}-${plan}-${randomUUID()}`
    await db.user.create({ data: { id, email: `${id}@example.test`, password: 'f', name: plan, plan, unlimited: opts.unlimited ?? false, role: opts.role || 'user' } })
    return id
  }
  async function burnVmMinutes(userId: string, minutes: number) {
    const task = await enqueueAgentTask({ goal: 'burn' } as any, userId, userId)
    await db.botRun.create({ data: { taskId: task.id, status: 'completed', events: [], computer: { minutes } } })
  }

  it('free plan gets the 5-minute teaser; pro gets its cap; unlimited bypasses', async () => {
    const freeUser = await makeUser('free')
    await expect(remainingVmMinutes(freeUser)).resolves.toBe(5)
    const proUser = await makeUser('pro')
    await expect(remainingVmMinutes(proUser)).resolves.toBe(BOT_VM_MINUTES_PER_DAY.pro)
    const adminUser = await makeUser('free', { unlimited: true })
    await expect(remainingVmMinutes(adminUser)).resolves.toBe(Number.MAX_SAFE_INTEGER)
  })

  it('enqueue clamps the TTL to the remaining budget and rejects when exhausted', async () => {
    const proUser = await makeUser('pro')
    await burnVmMinutes(proUser, BOT_VM_MINUTES_PER_DAY.pro - 10)
    await expect(remainingVmMinutes(proUser)).resolves.toBe(10)
    const clamped = await enqueueAgentTask({ goal: 'clamp me', computer: { enabled: true, ttlMinutes: 60 } } as any, proUser, proUser)
    expect((await raw(clamped.id)).computer).toMatchObject({ enabled: true, ttlMinutes: 10 })
    await burnVmMinutes(proUser, 10)
    await expect(enqueueAgentTask({ goal: 'no budget', computer: { enabled: true } } as any, proUser, proUser))
      .rejects.toMatchObject({ code: 'quota' })
  })
})