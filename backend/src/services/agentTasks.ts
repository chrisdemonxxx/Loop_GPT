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
import { Prisma } from '@prisma/client'
import { prisma, hasDb } from './prisma'
import { builtinToolNames } from '../agent'
import { THINKING_EFFORTS } from '../agent/thinking'
import { isE2BConfigured } from './e2bDesktop'
import { matchSkillsForGoal } from '../agent/skills/skillLoader'

export class AgentTaskError extends Error {
  constructor(
    public readonly code: 'invalid_request' | 'unavailable' | 'not_found' | 'lease_lost' | 'conflict' | 'forbidden' | 'quota',
    detail?: string,
  ) { super(detail || code) }
}

/** Ownership scope for reads/cancels. Users always pass their own id; admins
 *  pass none (they operate the whole queue, system tasks included). */
export interface TaskScope { userId?: string }

function scopePredicate(scope?: TaskScope) {
  return scope?.userId ? Prisma.sql`AND "userId" = ${scope.userId}` : Prisma.empty
}

/** Per-plan daily dedicated-computer budget (VM minutes). Free tier gets none;
 *  unlimited/admin bypass. The credit ledger charges the model work separately
 *  (kind 'bot'); VM minutes are metered on each BotRun and capped here. */
/** Per-plan daily dedicated-computer budget (VM minutes). The free tier gets
 *  a 5-minute daily teaser so every user can taste the computer (product
 *  decision 2026-10-05); pro/gold are the working budgets. */
export const BOT_VM_MINUTES_PER_DAY: Record<string, number> = { free: 5, pro: 30, gold: 120 }

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
  kind: z.enum(['ops', 'scheduled', 'teach']).default('ops'),
  schedule: z.string().regex(SCHEDULE_RE).optional(),
  model: z.string().regex(/^[A-Za-z0-9._:/-]{1,120}$/).optional(),
  thinking: z.string().refine((v) => (THINKING_EFFORTS as readonly string[]).includes(v)).optional(),
  allowedTools: z.array(z.string().regex(/^[A-Za-z0-9_]{1,64}$/)).max(32).optional(),
  maxSteps: z.number().int().min(1).max(64).optional(),
  computer: z.object({
    enabled: z.boolean(),
    ttlMinutes: z.number().int().min(5).max(240).optional(),
  }).optional(),
  /** Attach an existing skill as the run's operating procedure. */
  skillId: z.string().regex(/^[a-zA-Z0-9-]{1,64}$/).optional(),
  /** Named bot this task runs as. Omitted → the owner's primary Loop Bot. */
  botId: z.string().min(1).max(80).optional(),
  priority: z.number().int().min(-100).max(100).default(0),
})

export type EnqueueInput = z.infer<typeof enqueueInput>

function database() {
  if (!hasDb || !prisma) throw new AgentTaskError('unavailable')
  return prisma
}

// ── Enqueue / read / cancel (API side) ──────────────────────────────────────

/**
 * Enqueue an autonomous task. `createdBy` is the audit trail (who asked);
 * `ownerId` is the account the run executes as — its workspace, memory,
 * credits and live view. NULL owner = system task (service account).
 * Computer-enabled tasks check the owner's per-plan daily VM-minute budget and
 * clamp the TTL to what remains.
 */
export async function enqueueAgentTask(input: EnqueueInput, createdBy: string, ownerId: string | null = null) {
  if (!createdBy) throw new AgentTaskError('invalid_request')
  const parsed = enqueueInput.parse(input)
  if (parsed.kind === 'scheduled') {
    if (!parsed.schedule) throw new AgentTaskError('invalid_request')
    parseScheduleMs(parsed.schedule) // bounds check
  } else if (parsed.schedule) throw new AgentTaskError('invalid_request')
  // Teach tasks are demonstrations on the dedicated computer — computer-less
  // teach is meaningless.
  if (parsed.kind === 'teach' && !parsed.computer?.enabled) throw new AgentTaskError('invalid_request')
  // Bot v1: reviewed built-ins only. Extension sources come with the user-facing phase.
  const builtins = new Set(builtinToolNames())
  if (parsed.allowedTools?.some((name) => !builtins.has(name))) throw new AgentTaskError('invalid_request')

  let computer = parsed.computer
  if (computer?.enabled) {
    // Fail fast: an unconfigured provider would dead-letter this task after
    // pointless retries. Refuse at the API where the caller can act on it.
    if (!isE2BConfigured()) {
      throw new AgentTaskError('unavailable', 'Dedicated computer sessions are not configured on this deployment (E2B_API_KEY missing). Uncheck "Dedicated computer" or ask the operator to set it.')
    }
    if (ownerId) {
      const remaining = await remainingVmMinutes(ownerId)
      const ttl = Math.min(computer.ttlMinutes ?? 30, remaining)
      computer = { ...computer, ttlMinutes: ttl }
    }
  }
  let botId = parsed.botId ?? null
  if (ownerId) {
    try {
      const { primaryBotId } = await import('./bots')
      if (botId) {
        const owned = await database().bot.findFirst({ where: { id: botId, ownerId }, select: { id: true } })
        if (!owned) throw new AgentTaskError('invalid_request')
      } else {
        botId = await primaryBotId(ownerId)
      }
    } catch (error) {
      if (error instanceof AgentTaskError) throw error
      botId = parsed.botId ?? null
    }
  }
  const created = await database().agentTask.create({
    data: {
      kind: parsed.kind,
      goal: parsed.goal,
      schedule: parsed.schedule ?? null,
      model: parsed.model ?? null,
      thinking: parsed.thinking ?? null,
      allowedTools: parsed.allowedTools ?? undefined,
      maxSteps: parsed.maxSteps ?? null,
      computer: computer ?? undefined,
      skillId: parsed.skillId ?? null,
      botId,
      priority: parsed.priority,
      createdBy,
      userId: ownerId,
    },
    select: { id: true, kind: true, status: true, nextAttemptAt: true, computer: true, skillId: true },
  })
  // Auto-suggest (confirm-before-apply): when no explicit skill is attached,
  // surface trigger-matching skills the owner could attach instead. Carried on
  // the returned task row so callers that only read .id stay source-compatible.
  const task: any = created
  task.suggestedSkills = ownerId && !parsed.skillId && parsed.kind !== 'teach'
    ? matchSkillsForGoal(ownerId, parsed.goal)
    : []
  return task
}

/** Remaining dedicated-computer budget for the owner's current rolling window.
 *  Throws 'forbidden' (plan has no computer access) or 'quota' (day's minutes
 *  exhausted) instead of returning a number. Admins/unlimited bypass. */
export async function remainingVmMinutes(ownerId: string): Promise<number> {
  const db = database()
  const user = await db.user.findUnique({
    where: { id: ownerId },
    select: { plan: true, role: true, unlimited: true, creditsResetAt: true },
  })
  if (!user) throw new AgentTaskError('invalid_request')
  if (user.role === 'admin' || user.unlimited) return Number.MAX_SAFE_INTEGER
  const cap = BOT_VM_MINUTES_PER_DAY[user.plan] ?? 0
  if (cap <= 0) throw new AgentTaskError('forbidden')
  const rows = await db.$queryRaw<{ used: number | bigint }[]>`
    SELECT COALESCE(SUM((r."computer"->>'minutes')::int), 0)::bigint AS used
    FROM "BotRun" r JOIN "AgentTask" t ON t."id" = r."taskId"
    WHERE t."userId" = ${ownerId} AND r."startedAt" >= ${user.creditsResetAt}`
  const used = Number(rows[0]?.used ?? 0)
  const remaining = cap - used
  if (remaining <= 0) throw new AgentTaskError('quota')
  return remaining
}

export async function listAgentTasks(opts: { status?: string; limit?: number; scope?: TaskScope } = {}) {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200)
  const where: Record<string, unknown> = {}
  if (opts.status) where.status = opts.status
  if (opts.scope?.userId) where.userId = opts.scope.userId
  return database().agentTask.findMany({
    where,
    orderBy: [{ status: 'asc' }, { priority: 'desc' }, { nextAttemptAt: 'asc' }],
    take: limit,
    select: {
      id: true, kind: true, goal: true, status: true, schedule: true, model: true,
      priority: true, attempts: true, failures: true, nextAttemptAt: true,
      cancelRequested: true, lastErrorCode: true, createdBy: true, createdAt: true, updatedAt: true,
      computer: true, userId: true, botId: true,
    },
  })
}

export async function getAgentTask(id: string, scope?: TaskScope) {
  const task = await database().agentTask.findFirst({
    where: { id, ...(scope?.userId ? { userId: scope.userId } : {}) },
    include: { runs: { orderBy: { startedAt: 'desc' }, take: 10, select: {
      id: true, status: true, error: true, startedAt: true, completedAt: true,
    } } },
  })
  // Not-found, not forbidden: do not leak that another owner's task exists.
  if (!task) throw new AgentTaskError('not_found')
  return task
}

/** Cancel: queued rows retire immediately; a processing row is flagged and the
 *  worker aborts it on its next heartbeat tick. Scoped callers (users) can
 *  only touch their own tasks; unscoped (admin) can touch any. */
export async function cancelAgentTask(id: string, scope?: TaskScope) {
  const db = database()
  const scopeSql = scopePredicate(scope)
  const retired = await db.$executeRaw`
    UPDATE "AgentTask" SET "status" = 'cancelled', "leaseToken" = NULL, "leaseExpiresAt" = NULL,
      "updatedAt" = clock_timestamp()
    WHERE "id" = ${id} AND "status" = 'queued' ${scopeSql}`
  if (retired === 1) return { cancelled: true, immediate: true }
  const flagged = await db.$executeRaw`
    UPDATE "AgentTask" SET "cancelRequested" = true, "updatedAt" = clock_timestamp()
    WHERE "id" = ${id} AND "status" = 'processing' AND "cancelRequested" = false ${scopeSql}`
  if (flagged === 1) return { cancelled: true, immediate: false }
  throw new AgentTaskError('conflict')
}

export async function isCancelRequested(taskId: string): Promise<boolean> {
  const rows = await database().agentTask.findUnique({ where: { id: taskId }, select: { cancelRequested: true, status: true } })
  return !!rows && (rows.cancelRequested || rows.status === 'cancelled')
}

// ── Claim / ack / fail (worker side) ────────────────────────────────────────

export interface AgentTaskClaim { taskId: string; leaseToken: string }

/** Claim only durable rows. Priority first, then due time; expired leases replay.
 *  Fair queueing (B5): never claim a second task for a user who already has one
 *  processing — per-user concurrency stays 1 no matter the worker's batch size. */
export async function claimAgentTasks(options: { batchSize: number; leaseMs: number }): Promise<AgentTaskClaim[]> {
  const token = randomUUID()
  return database().$queryRaw<AgentTaskClaim[]>`
    WITH candidates AS (
      SELECT "id" FROM "AgentTask"
      WHERE (("status" = 'queued' AND "nextAttemptAt" <= clock_timestamp())
         OR ("status" = 'processing' AND "leaseExpiresAt" <= clock_timestamp()))
        AND NOT EXISTS (
          SELECT 1 FROM "AgentTask" busy
          WHERE busy."status" = 'processing'
            AND busy."leaseExpiresAt" > clock_timestamp()
            AND busy."userId" IS NOT NULL
            AND busy."userId" = "AgentTask"."userId"
        )
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

/** Permanent failure codes: the condition cannot heal inside a retry window
 *  (missing provider config, invalid task, out of daily credits) — dead-letter
 *  on the FIRST attempt instead of burning three. Transient codes keep the
 *  deterministic backoff. */
export const BOT_PERMANENT_FAILURES = ['BOT_TASK_INVALID', 'BOT_COMPUTER_UNCONFIGURED', 'BOT_OUT_OF_CREDITS'] as const

/** Failure recording with deterministic DB-clock backoff; mirrors the settlement
 *  workers: never reset a row we no longer own, never resurrect a dead letter. */
export async function failAgentTask(claim: AgentTaskClaim, code: string, message?: string): Promise<'retry' | 'cancelled' | 'dead_letter' | 'lease_lost'> {
  const lastError = (message || code).slice(0, 500)
  const rows = await database().$queryRaw<{ status: string }[]>`
    UPDATE "AgentTask"
    SET "status" = CASE
          WHEN ${code} = 'BOT_TASK_CANCELLED' THEN 'cancelled'
          WHEN ${code} IN ('BOT_TASK_INVALID', 'BOT_COMPUTER_UNCONFIGURED', 'BOT_OUT_OF_CREDITS') THEN 'dead_letter'
          WHEN "attempts" >= ${AGENT_TASK_MAX_ATTEMPTS} THEN 'dead_letter'
          ELSE 'queued' END,
        "nextAttemptAt" = CASE
          WHEN ${code} = 'BOT_TASK_CANCELLED' OR "attempts" >= ${AGENT_TASK_MAX_ATTEMPTS}
               OR ${code} IN ('BOT_TASK_INVALID', 'BOT_COMPUTER_UNCONFIGURED', 'BOT_OUT_OF_CREDITS') THEN "nextAttemptAt"
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
