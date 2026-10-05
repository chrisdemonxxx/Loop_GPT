/**
 * Bot run computer metadata + cross-process takeover (DB-gated integration):
 * the admin process writes via the same services the API uses; the worker
 * polls the same row. Covers the Phase 3 rendezvous contract.
 */
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { prisma } from '../prisma'
import { enqueueAgentTask } from '../agentTasks'
import {
  getRun,
  getRunComputer,
  isRunTakeoverRequested,
  setRunComputer,
  setRunTakeover,
  startRun,
} from '../botRuns'

const db = prisma!
process.env.E2B_API_KEY ||= 'integration-test-key'
const prefix = `botcomputer-${randomUUID()}`
let creatorId: string
let taskId: string

beforeEach(async () => {
  creatorId = `${prefix}-${randomUUID()}`
  // pro plan: the B4 VM-minute gate passes (free gets no dedicated computer).
  await db.user.create({ data: { id: creatorId, email: `${creatorId}@example.test`, password: 'fixture', name: 'Fixture', plan: 'pro' } })
  // Owner == creator: this fixture's tasks are user-owned (not system tasks).
  const task = await enqueueAgentTask({ goal: `goal-${randomUUID()}`, computer: { enabled: true, ttlMinutes: 30 } }, creatorId, creatorId)
  taskId = task.id
})

afterEach(async () => {
  await db.botRun.deleteMany({ where: { task: { createdBy: { startsWith: prefix } } } })
  await db.agentTask.deleteMany({ where: { createdBy: { startsWith: prefix } } })
  await db.user.deleteMany({ where: { id: { startsWith: prefix } } })
})

describe('run computer metadata', () => {
  it('persists and merges session info (worker writes, admin reads)', async () => {
    const run = await startRun(taskId)
    await setRunComputer(run.runId, { sandboxId: 'sbx-1', viewUrl: 'https://v', interactiveUrl: 'https://i', streamAuthKey: 'k', startedAt: new Date().toISOString() })
    const first = await getRunComputer(run.runId)
    expect(first).toMatchObject({ sandboxId: 'sbx-1', viewUrl: 'https://v' })
    await setRunComputer(run.runId, { minutes: 3, endedAt: new Date().toISOString() })
    const merged = await getRunComputer(run.runId)
    expect(merged).toMatchObject({ sandboxId: 'sbx-1', minutes: 3 })
    // And the row itself carries it (the admin process may have no live view).
    const row = await db.botRun.findUniqueOrThrow({ where: { id: run.runId } })
    expect((row.computer as any)?.sandboxId).toBe('sbx-1')
    expect((row.computer as any)?.minutes).toBe(3)
    await run.complete({ content: 'done', artifacts: [], usage: undefined })
  })
})

describe('cross-process takeover flag', () => {
  it('admin set → worker poll observes; release clears', async () => {
    const run = await startRun(taskId)
    expect(await isRunTakeoverRequested(run.runId)).toBe(false)
    expect(await setRunTakeover(run.runId, true)).toBe(true)
    expect(await isRunTakeoverRequested(run.runId)).toBe(true)
    const info = await getRunComputer(run.runId)
    expect(info?.takeoverRequested).toBe(true)
    expect(await setRunTakeover(run.runId, false)).toBe(true)
    expect(await isRunTakeoverRequested(run.runId)).toBe(false)
    await run.complete({ content: 'done', artifacts: [], usage: undefined })
  })

  it('refuses takeover on finished runs', async () => {
    const run = await startRun(taskId)
    await run.complete({ content: 'done', artifacts: [], usage: undefined })
    expect(await setRunTakeover(run.runId, true)).toBe(false)
  })
})

// ── B1: run ownership scoping ───────────────────────────────────────────────

describe('run ownership scoping (B1)', () => {
  let strangerId: string

  beforeEach(async () => {
    strangerId = `${prefix}-stranger-${randomUUID()}`
    await db.user.create({ data: { id: strangerId, email: `${strangerId}@example.test`, password: 'f', name: 'Stranger' } })
  })

  it('scoped reads see only their own runs; system runs are invisible to users', async () => {
    // taskId from the fixture is owned by creatorId (user-owned task)
    const run = await startRun(taskId)
    await setRunComputer(run.runId, { sandboxId: 'sbx-owner', viewUrl: 'https://v', interactiveUrl: 'https://i' })

    expect(await getRun(run.runId, creatorId)).toMatchObject({ id: run.runId })
    expect(await getRun(run.runId, strangerId)).toBeUndefined()
    expect(await getRunComputer(run.runId, strangerId)).toBeUndefined()
    expect(await setRunTakeover(run.runId, true, strangerId)).toBe(false)
    expect(await isRunTakeoverRequested(run.runId)).toBe(false) // stranger touched nothing
    expect(await setRunTakeover(run.runId, true, creatorId)).toBe(true)
    // Unscoped (admin) sees it regardless.
    expect(await getRun(run.runId)).toMatchObject({ id: run.runId })
    await run.fail('done', true)
  })

  it('a system task (NULL owner) rejects every scoped access', async () => {
    const sysTask = await enqueueAgentTask({ goal: 'system' } as any, creatorId)
    const run = await startRun(sysTask.id)
    expect(await getRun(run.runId, strangerId)).toBeUndefined()
    expect(await getRun(run.runId, creatorId)).toBeUndefined() // creator is admin-side, not owner
    expect(await setRunTakeover(run.runId, true, creatorId)).toBe(false)
    expect(await getRun(run.runId)).toMatchObject({ id: run.runId }) // admin unscoped
    await run.fail('done', true)
  })
})
