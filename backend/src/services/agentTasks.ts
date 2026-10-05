/**
 * Durable autonomous agent task queue ("bot computer").
 *
 * The claim/ack pattern mirrors apiSettlementRecovery.ts exactly: DB-clock
 * leases, FOR UPDATE SKIP LOCKED, guarded acknowledgements, deterministic
 * DB-clock backoff. A worker never trusts its own clock for ownership —
 * every mutation is guarded by (id, leaseToken, leaseExpiresAt > clock).
 *
 * Task kinds:
 *  - 'ops'       one-shot: queued → processing → succeeded | dead_letter | cancelled
 *  - 'scheduled' recurring: after each success the row returns to 'queued'
 *                with nextAttemptAt = DB clock + the interval; 'cancelled' retires it.
 */
import { randomUUID } from 'crypto'
import { z } from 'zod'
import { prisma, hasDb } from './prisma'
import { builtinToolNames } from '../agent'
import { THINKING_EFFORTS } from '../agent/thinking'

export class AgentTaskError extends Error {
  constructor(public readonly code: 'invalid_request' | 'unavailable' | 'not_found' | 'lease_lost' | 'conflict') { super(code) }
}

export const AGENT_TASK_MAX_ATTEMPTS = 3

/** Read-only default toolset for autonomous runs. Media generation, voice,
 *  and mutation tools (create_skill / create_custom_tool) stay out unless an
 *  admin explicitly allowlists them per task. */
export const BOT_DEFAULT_TOOLS: readonly string[] = [
  'web_search', 'web_fetch', 'execute_code', 'create_document',
  'calculator', 'get_current_time', 'remember', 'search_knowledge',
]

// ── Validation ──────────────────────────────────────────────────────────────

const SCHEDULE_RE = /^(\d+)([mhd])$/
const SCHEDULE_BOUNDS_MS: Record<string, [number, number]> = {
  m: [5 * 60_000, 10_080 * 60_000], // 5 minutes .. 7 days
  h: [60 * 60_000, 168 * 60 * 60_000], // 1 hour .. 7 days
  d: [24 * 60 * 60_000, 30 * 24 * 60 * 60_000], // 1 day .. 30 days
}

/** "<n>m" | "<n>h" | "<n>d" → milliseconds, bounded. Throws AgentTaskError. */
export function parseScheduleMs(schedule: string): number {
  const match = SCHEDULE_RE.exec(schedule)
  if (!match) throw new AgentTaskError('invalid_request')
  const n = Number(match[1])
  const unit = match[2]
  const ms = unit === 'm' ? n * 60_000 : unit === 'h' ? n * 60 * 60_000 : n * 24 * 60 * 60_000
  const [min, max] = SCHEDULE_BOUNDS_MS[unit]
  if (!Number.isSafeInteger(ms) || ms < min || ms > max) throw new AgentTaskError('invalid_request')
  return ms
}

export const enqueueInput = z.object({
  goal: z.string().trim().min(1).max(20_000),
  kind: z.enum(['ops', 'scheduled']).default('ops'),
  schedule: z.string().regex(SCHEDULE_RE).optional(),
  model: z.string().regex(/^[A-Za-z0-9._:/-]{1,120}$/).optional(),
  thinking: z.string().refine((v) => (THINKING_EFFORTS as readonly string[]).includes(v)).optional(),
  allowedTools: z.array(z.string().regex(/^[A-Za-z0-9_]{1,64}$/)).max(32).optional(),
  maxSteps: z.number().int().min(1).max(64).optional(),
  /** Dedicated computer session (E2B Desktop): a per-run cloud VM the agent
   *  drives via computer_* tools; admins watch live and can take over. */
  computer: z.object({
    enabled: z.boolean(),
    ttlMinutes: z.number().int().min(5).max(240).optional(),
  }).optional(),
  priority: z.number().int().min(-100).max(100).default(0),
})

export type EnqueueInput = z.infer<typeof enqueueInput>

function database() {
  if (!hasDb || !prisma) throw new AgentTaskError('unavailable')
  return prisma
}

// ── Enqueue / read / cancel (API side) ──────────────────────────────────────

export async function enqueueAgentTask(input: EnqueueInput, createdBy: string) {
  if (!createdBy) throw new AgentTaskError('invalid_request')
  const parsed = enqueueInput.parse(input)
  if (parsed.kind === 'scheduled') {
    if (!parsed.schedule) throw new AgentTaskError('invalid_request')
    parseScheduleMs(parsed.schedule) // bounds check
  } else if (parsed.schedule) throw new AgentTaskError('invalid_request')
  // Bot v1: reviewed built-ins only. Extension sources come with the user-facing phase.
  const builtins = new Set(builtinToolNames())
  if (parsed.allowedTools?.some((name) => !builtins.has(name))) throw new AgentTaskError('invalid_request')
  return database().agentTask.create({
    data: {
      kind: parsed.kind,
      goal: parsed.goal,
      schedule: parsed.schedule ?? null,
      model: parsed.model ?? null,
      thinking: parsed.thinking ?? null,
      allowedTools: parsed.allowedTools ?? undefined,
      maxSteps: parsed.maxSteps ?? null,
      computer: parsed.computer ?? undefined,
      priority: parsed.priority,
      createdBy,
    },
    select: { id: true, kind: true, status: true, nextAttemptAt: true },
  })
}

export async function listAgentTasks(opts: { status?: string; limit?: number } = {}) {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200)
  const where = opts.status ? { status: opts.status } : {}
  return database().agentTask.findMany({
    where,
    orderBy: [{ status: 'asc' }, { priority: 'desc' }, { nextAttemptAt: 'asc' }],
    take: limit,
    select: {
      id: true, kind: true, goal: true, status: true, schedule: true, model: true,
      priority: true, attempts: true, failures: true, nextAttemptAt: true,
      cancelRequested: true, lastErrorCode: true, createdBy: true, createdAt: true, updatedAt: true,
      computer: true,
    },
  })
}

export async function getAgentTask(id: string) {
  const task = await database().agentTask.findUnique({
    where: { id },
    include: { runs: { orderBy: { startedAt: 'desc' }, take: 10, select: {
      id: true, status: true, error: true, startedAt: true, completedAt: true,
    } } },
  })
  if (!task) throw new AgentTaskError('not_found')
  return task
}

/** Operator cancel: queued rows retire immediately; a processing row is
 *  flagged and the worker aborts it on its next heartbeat tick. */
export async function cancelAgentTask(id: string) {
  const db = database()
  const retired = await db.$executeRaw`
    UPDATE "AgentTask" SET "status" = 'cancelled', "leaseToken" = NULL, "leaseExpiresAt" = NULL,
      "updatedAt" = clock_timestamp()
    WHERE "id" = ${id} AND "status" = 'queued'`
  if (retired === 1) return { cancelled: true, immediate: true }
  const flagged = await db.$executeRaw`
    UPDATE "AgentTask" SET "cancelRequested" = true, "updatedAt" = clock_timestamp()
    WHERE "id" = ${id} AND "status" = 'processing' AND "cancelRequested" = false`
  if (flagged === 1) return { cancelled: true, immediate: false }
  throw new AgentTaskError('conflict')
}

export async function isCancelRequested(taskId: string): Promise<boolean> {
  const rows = await database().agentTask.findUnique({ where: { id: taskId }, select: { cancelRequested: true, status: true } })
  return !!rows && (rows.cancelRequested || rows.status === 'cancelled')
}

// ── Claim / ack / fail (worker side) ────────────────────────────────────────

export interface AgentTaskClaim { taskId: string; leaseToken: string }

/** Claim only durable rows. Priority first, then due time; expired leases replay. */
export async function claimAgentTasks(options: { batchSize: number; leaseMs: number }): Promise<AgentTaskClaim[]> {
  const token = randomUUID()
  return database().$queryRaw<AgentTaskClaim[]>`
    WITH candidates AS (
      SELECT "id" FROM "AgentTask"
      WHERE ("status" = 'queued' AND "nextAttemptAt" <= clock_timestamp())
         OR ("status" = 'processing' AND "leaseExpiresAt" <= clock_timestamp())
      ORDER BY "priority" DESC,
        CASE WHEN "status" = 'processing' THEN "leaseExpiresAt" ELSE "nextAttemptAt" END, "id"
      LIMIT ${options.batchSize} FOR UPDATE SKIP LOCKED
    )
    UPDATE "AgentTask" AS task
    SET "status" = 'processing', "leaseToken" = ${token},
        "leaseExpiresAt" = clock_timestamp() + (${options.leaseMs} * interval '1 millisecond'),
        "attempts" = LEAST(task."attempts" + 1, ${AGENT_TASK_MAX_ATTEMPTS + 1}), "updatedAt" = clock_timestamp()
    FROM candidates WHERE task."id" = candidates."id"
    RETURNING task."id" AS "taskId", task."leaseToken"`
}

/** Renew the lease mid-run (heartbeat). False means ownership was lost —
 *  the run must stop instead of racing another worker. */
export async function renewAgentTaskLease(claim: AgentTaskClaim, leaseMs: number): Promise<boolean> {
  const renewed = await database().$executeRaw`
    UPDATE "AgentTask" SET "leaseExpiresAt" = clock_timestamp() + (${leaseMs} * interval '1 millisecond'),
      "updatedAt" = clock_timestamp()
    WHERE "id" = ${claim.taskId} AND "status" = 'processing'
      AND "leaseToken" = ${claim.leaseToken} AND "leaseExpiresAt" > clock_timestamp()`
  return renewed === 1
}

/** Success ack. One-shot tasks retire; scheduled tasks requeue at DB clock + interval. */
export async function completeAgentTask(claim: AgentTaskClaim): Promise<'succeeded' | 'lease_lost'> {
  const db = database()
  const task = await db.agentTask.findUnique({ where: { id: claim.taskId }, select: { kind: true, schedule: true } })
  const intervalMs = task?.kind === 'scheduled' && task.schedule ? parseScheduleMs(task.schedule) : null
  const count = await db.$executeRaw`
    UPDATE "AgentTask"
    SET "status" = CASE WHEN ${intervalMs}::bigint IS NULL THEN 'succeeded' ELSE 'queued' END,
        "attempts" = CASE WHEN ${intervalMs}::bigint IS NULL THEN "attempts" ELSE 0 END,
        "nextAttemptAt" = CASE WHEN ${intervalMs}::bigint IS NULL THEN "nextAttemptAt"
          ELSE clock_timestamp() + (${intervalMs} * interval '1 millisecond') END,
        "cancelRequested" = false, "lastErrorCode" = NULL, "lastError" = NULL,
        "leaseToken" = NULL, "leaseExpiresAt" = NULL, "updatedAt" = clock_timestamp()
    WHERE "id" = ${claim.taskId} AND "status" = 'processing'
      AND "leaseToken" = ${claim.leaseToken} AND "leaseExpiresAt" > clock_timestamp()`
  return count === 1 ? 'succeeded' : 'lease_lost'
}

export type AgentTaskOutcome = 'succeeded' | 'cancelled' | 'retry' | 'dead_letter' | 'lease_lost'

/** Failure recording with deterministic DB-clock backoff; mirrors the settlement
 *  workers: never reset a row we no longer own, never resurrect a dead letter. */
export async function failAgentTask(claim: AgentTaskClaim, code: string, message?: string): Promise<'retry' | 'cancelled' | 'dead_letter' | 'lease_lost'> {
  const lastError = (message || code).slice(0, 500)
  const rows = await database().$queryRaw<{ status: string }[]>`
    UPDATE "AgentTask"
    SET "status" = CASE
          WHEN ${code} = 'BOT_TASK_CANCELLED' THEN 'cancelled'
          WHEN "attempts" >= ${AGENT_TASK_MAX_ATTEMPTS} THEN 'dead_letter'
          ELSE 'queued' END,
        "nextAttemptAt" = CASE
          WHEN ${code} = 'BOT_TASK_CANCELLED' OR "attempts" >= ${AGENT_TASK_MAX_ATTEMPTS} THEN "nextAttemptAt"
          ELSE statement_timestamp() + (LEAST(300000, 1000 * power(2, LEAST("attempts" - 1, 9))) * interval '1 millisecond') END,
        "failures" = "failures" + CASE WHEN ${code} = 'BOT_TASK_CANCELLED' THEN 0 ELSE 1 END,
        "cancelRequested" = false,
        "lastErrorCode" = ${code.slice(0, 80)}, "lastError" = ${lastError},
        "leaseToken" = NULL, "leaseExpiresAt" = NULL, "updatedAt" = statement_timestamp()
    WHERE "id" = ${claim.taskId} AND "status" = 'processing'
      AND "leaseToken" = ${claim.leaseToken} AND "leaseExpiresAt" > clock_timestamp()
    RETURNING "status"`
  if (!rows.length) return 'lease_lost'
  return rows[0].status === 'queued' ? 'retry' : rows[0].status as 'cancelled' | 'dead_letter'
}
