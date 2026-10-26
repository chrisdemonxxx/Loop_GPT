/**
 * Routines: the product shape of a recurring job — one bot, one skill, one
 * schedule, an approval boundary, and a run history.
 *
 * A routine is not a new kind of thing: it is a scheduled AgentTask, so the
 * existing claim/lease/retry machinery runs it, and this module stays a thin
 * owner-scoped read/write layer over that table. Two stores for one concept
 * would drift; one store with two views cannot.
 */
import { hasDb, prisma } from './prisma'
import { parseRoutineSchedule } from './routineSchedule'

/** nextAttemptAt this far out means paused: the row stays, its history stays,
 *  and the claim loop never picks it up. */
const PAUSED_AT = new Date('2099-12-31T00:00:00Z')

export interface RoutineRun {
  id: string
  status: string
  error: string | null
  result: string | null
  startedAt: string | null
  completedAt: string | null
}

export interface Routine {
  id: string
  goal: string
  schedule: string
  skillId: string | null
  botId: string | null
  status: string
  paused: boolean
  nextRunAt: string | null
  createdAt: string
  /** Latest run's result text, when a run has one. */
  result: string | null
  runs: RoutineRun[]
  timezone: string
  autoPauseWhenAway: boolean
  pausedReason: 'user' | 'away' | null
}

function toRoutine(row: any): Routine {
  const nextRunAt = row.nextAttemptAt ? new Date(row.nextAttemptAt) : null
  const schedule = parseRoutineSchedule(row.schedule || '')
  const paused = !!nextRunAt && nextRunAt.getTime() >= PAUSED_AT.getTime()
  return {
    id: row.id,
    goal: row.goal,
    schedule: row.schedule || '',
    skillId: row.skillId ?? null,
    botId: row.botId ?? null,
    status: row.status,
    paused,
    timezone: schedule.timeZone,
    autoPauseWhenAway: schedule.autoPauseWhenAway,
    pausedReason: paused ? (row.lastErrorCode === 'AWAY' ? 'away' : 'user') : null,
    nextRunAt: nextRunAt ? nextRunAt.toISOString() : null,
    createdAt: row.createdAt ? new Date(row.createdAt).toISOString() : '',
    result: row.runs?.[0]?.result ?? null,
    runs: (row.runs || []).map((run: any) => ({
      id: run.id,
      status: run.status,
      error: run.error ?? null,
      result: run.result ?? null,
      startedAt: run.startedAt ? new Date(run.startedAt).toISOString() : null,
      completedAt: run.completedAt ? new Date(run.completedAt).toISOString() : null,
    })),
  }
}

export async function listRoutines(userId: string): Promise<Routine[]> {
  if (!hasDb || !prisma) return []
  const rows = await prisma.agentTask.findMany({
    where: { userId, kind: 'scheduled', status: { not: 'cancelled' } },
    orderBy: { createdAt: 'desc' },
    include: {
      runs: { orderBy: { startedAt: 'desc' }, take: 20, select: { id: true, status: true, error: true, result: true, startedAt: true, completedAt: true } },
    },
  })
  return rows.map(toRoutine)
}

export async function createRoutine(
  userId: string,
  input: {
    goal: string
    schedule: string
    skillId?: string
    botId?: string
    allowedTools?: string[]
    computer?: { enabled: boolean; ttlMinutes?: number }
    conversationId?: string
  },
): Promise<Routine> {
  const { enqueueAgentTask } = await import('./agentTasks')
  const task = await enqueueAgentTask(
    {
      goal: input.goal,
      kind: 'scheduled',
      schedule: input.schedule,
      ...(input.skillId ? { skillId: input.skillId } : {}),
      ...(input.botId ? { botId: input.botId } : {}),
      ...(input.allowedTools ? { allowedTools: input.allowedTools } : {}),
      ...(input.computer ? { computer: input.computer } : {}),
      ...(input.conversationId ? { conversationId: input.conversationId } : {}),
      priority: 0,
    },
    userId,
    userId,
  )
  return toRoutine({ ...task, runs: [] })
}

/** Pause moves the next run to the far future; resume schedules it for now.
 *  Resuming a dead-lettered routine re-queues it (clears the permanent failure). */
export async function setRoutinePaused(userId: string, id: string, paused: boolean): Promise<Routine | null> {
  if (!hasDb || !prisma) return null
  const owned = await prisma.agentTask.findFirst({ where: { id, userId, kind: 'scheduled' }, select: { id: true, status: true } })
  if (!owned) return null
  if (paused) {
    await prisma.agentTask.update({ where: { id }, data: { nextAttemptAt: PAUSED_AT } })
  } else {
    const revive = owned.status === 'dead_letter'
    await prisma.agentTask.update({
      where: { id },
      data: {
        nextAttemptAt: new Date(),
        ...(revive
          ? {
              status: 'queued',
              attempts: 0,
              lastError: null,
              lastErrorCode: null,
              cancelRequested: false,
              leaseToken: null,
              leaseExpiresAt: null,
            }
          : {}),
      },
    })
  }
  const rows = await prisma.agentTask.findFirst({
    where: { id },
    include: { runs: { orderBy: { startedAt: 'desc' }, take: 20, select: { id: true, status: true, error: true, result: true, startedAt: true, completedAt: true } } },
  })
  return rows ? toRoutine(rows) : null
}

export async function pauseRoutinesForAway(userId: string, ids: string[]): Promise<void> {
  if (!hasDb || !prisma || !ids.length) return
  await prisma.agentTask.updateMany({
    where: { id: { in: ids }, userId, kind: 'scheduled', status: { not: 'cancelled' } },
    data: { nextAttemptAt: PAUSED_AT, lastErrorCode: 'AWAY' },
  })
}

export async function deleteRoutine(userId: string, id: string): Promise<boolean> {
  if (!hasDb || !prisma) return false
  const owned = await prisma.agentTask.findFirst({
    where: { id, userId, kind: 'scheduled' },
    select: { status: true },
  })
  if (!owned || owned.status === 'cancelled') return false
  // A paused routine keeps whatever status the last run left (often succeeded).
  // It is still listed, so delete has to cancel that row too.
  if (owned.status !== 'processing') {
    const updated = await prisma.agentTask.updateMany({
      where: { id, userId, kind: 'scheduled', status: owned.status },
      data: {
        status: 'cancelled',
        leaseToken: null,
        leaseExpiresAt: null,
        cancelRequested: false,
      },
    })
    return updated.count === 1
  }
  const { cancelAgentTask } = await import('./agentTasks')
  try {
    await cancelAgentTask(id, { userId })
    return true
  } catch {
    return false
  }
}
