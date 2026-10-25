/**
 * Interactive Computer-tab VM-minute metering.
 *
 * Task runs already stamp minutes on BotRun.computer when the session closes.
 * Opening the always-on box via POST /computer/wake also consumes budget —
 * this module records that time into a standing AgentTask + BotRun so
 * remainingVmMinutes() sees it.
 */
import { prisma, hasDb } from './prisma'

const INTERACTIVE_GOAL = '__interactive_computer__'

/** Bill whole VM minutes since the previous settle on the standing interactive
 *  BotRun. Returns the minutes added by this call (0 when less than a minute
 *  elapsed). A zero bill does not move lastSettledAt, so the sub-minute gap
 *  is still there for the next settle. */
export async function recordInteractiveVmMinutes(userId: string): Promise<number> {
  if (!hasDb || !prisma) return 0
  // Soft quota check: never fail a successful wake/resume. If the day's
  // minutes are spent, skip billing and let the already-booted box stream.
  const { remainingVmMinutes, AgentTaskError } = await import('./agentTasks')
  try {
    await remainingVmMinutes(userId)
  } catch (err) {
    if (err instanceof AgentTaskError && (err.code === 'quota' || err.code === 'forbidden')) {
      return 0
    }
    throw err
  }

  const now = new Date()
  let task = await prisma.agentTask.findFirst({
    where: { userId, goal: INTERACTIVE_GOAL, kind: 'ops' },
    orderBy: { createdAt: 'desc' },
    include: { runs: { orderBy: { startedAt: 'desc' }, take: 1 } },
  })
  if (!task) {
    task = await prisma.agentTask.create({
      data: {
        kind: 'ops',
        goal: INTERACTIVE_GOAL,
        status: 'succeeded',
        createdBy: userId,
        userId,
        priority: -100,
      },
      include: { runs: { orderBy: { startedAt: 'desc' }, take: 1 } },
    })
  }

  const existing = task.runs[0]
  const computer = (existing?.computer as { minutes?: number; startedAt?: string; endedAt?: string; lastSettledAt?: string } | null) || {}
  const lastSettled = computer.lastSettledAt ? new Date(computer.lastSettledAt).getTime() : 0
  // First wake of a session bills 1 minute; subsequent wakes bill whole minutes
  // elapsed since the last settle (rapid re-wakes under 60s add nothing).
  const elapsedMs = lastSettled > 0 ? Math.max(0, now.getTime() - lastSettled) : 60_000
  const addMinutes = lastSettled > 0
    ? Math.floor(elapsedMs / 60_000)
    : 1
  if (addMinutes <= 0) return 0
  const minutes = (computer.minutes || 0) + addMinutes
  const payload = {
    minutes,
    startedAt: computer.startedAt || now.toISOString(),
    endedAt: now.toISOString(),
    lastSettledAt: now.toISOString(),
  }

  if (existing) {
    await prisma.botRun.update({
      where: { id: existing.id },
      data: {
        status: 'completed',
        computer: payload as any,
        completedAt: now,
      },
    })
  } else {
    await prisma.botRun.create({
      data: {
        taskId: task.id,
        status: 'completed',
        events: [],
        computer: payload as any,
        startedAt: now,
        completedAt: now,
      },
    })
  }
  return addMinutes
}
