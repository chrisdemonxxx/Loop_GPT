/**
 * Operator input captured during an in-progress teach run.
 *
 * The API process appends; the bot worker (often another process) reads.
 * Same-process callers share the module map. The list is also mirrored onto
 * BotRun.computer.teachSteps — no dedicated column — so the worker can load
 * steps the API wrote. Coordinates are framebuffer pixels (1366×768), not CSS.
 */
import { hasDb, prisma } from './prisma'

export type TeachStepKind = 'click' | 'key' | 'type'

export interface TeachStep {
  at: number
  kind: TeachStepKind
  x?: number
  y?: number
  key?: string
  text?: string
}

const MAX_STEPS = 2000
const stepsByRun = new Map<string, TeachStep[]>()

export function parseTeachStep(body: unknown): TeachStep | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  const raw = body as Record<string, unknown>
  if (typeof raw.at !== 'number' || !Number.isFinite(raw.at)) return null
  if (raw.kind === 'click') {
    if (typeof raw.x !== 'number' || typeof raw.y !== 'number') return null
    if (!Number.isFinite(raw.x) || !Number.isFinite(raw.y)) return null
    const x = Math.round(raw.x)
    const y = Math.round(raw.y)
    if (x < 0 || y < 0 || x > 10000 || y > 10000) return null
    return { at: raw.at, kind: 'click', x, y }
  }
  if (raw.kind === 'key') {
    if (typeof raw.key !== 'string') return null
    const key = raw.key.trim()
    if (!key || key.length > 64) return null
    return { at: raw.at, kind: 'key', key }
  }
  if (raw.kind === 'type') {
    if (typeof raw.text !== 'string' || !raw.text || raw.text.length > 4000) return null
    return { at: raw.at, kind: 'type', text: raw.text }
  }
  return null
}

/** `click 640,400` / `key Enter` / `type hello`, one step per line. */
export function formatTeachStepLog(steps: TeachStep[]): string {
  return steps.map((step) => {
    if (step.kind === 'click') return `click ${step.x},${step.y}`
    if (step.kind === 'key') return `key ${step.key}`
    return `type ${step.text}`
  }).join('\n')
}

export function noteTeachStep(runId: string, step: TeachStep): void {
  const list = stepsByRun.get(runId)
  if (list) list.push(step)
  else stepsByRun.set(runId, [step])
}

export function clearTeachSteps(runId: string): void {
  stepsByRun.delete(runId)
}

function asComputer(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return { ...(value as Record<string, unknown>) }
}

async function readPersistedTeachSteps(runId: string): Promise<TeachStep[]> {
  if (!prisma) return []
  try {
    const row = await prisma.botRun.findUnique({ where: { id: runId }, select: { computer: true } })
    const stored = asComputer(row?.computer).teachSteps
    if (!Array.isArray(stored)) return []
    return stored.map(parseTeachStep).filter((step): step is TeachStep => step !== null)
  } catch {
    return []
  }
}

/** In-memory log when this process recorded the steps; otherwise the DB mirror. */
export async function loadTeachSteps(runId: string): Promise<TeachStep[]> {
  const memory = stepsByRun.get(runId) ?? []
  const persisted = await readPersistedTeachSteps(runId)
  if (persisted.length > memory.length) return persisted
  return memory.slice()
}

export type RecordTeachStepResult =
  | { ok: true; stored: boolean }
  | { ok: false; status: number; error: string; code?: string }

/**
 * Append one operator step for an owned, in-progress teach run.
 * Takeover can still be in flight — store the step anyway so distill sees
 * the same clicks the operator made. A run that is not a live teach run is
 * acknowledged with stored: false. Invalid bodies are rejected only while
 * that teach run is still active.
 */
export async function recordTeachStep(runId: string, userId: string, body: unknown): Promise<RecordTeachStepResult> {
  if (!hasDb || !prisma) {
    return { ok: false, status: 503, error: 'Loop Bot requires a database.', code: 'unavailable' }
  }
  const outcome = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM "BotRun" WHERE "id" = ${runId} FOR UPDATE`
    const row = await tx.botRun.findUnique({
      where: { id: runId },
      select: {
        status: true,
        computer: true,
        task: { select: { kind: true, userId: true } },
      },
    })
    if (!row || row.task.userId !== userId) return { type: 'missing' as const }
    if (row.task.kind !== 'teach' || row.status !== 'running') {
      return { type: 'ignored' as const }
    }
    const step = parseTeachStep(body)
    if (!step) return { type: 'invalid' as const }
    const computer = asComputer(row.computer)
    const prev = Array.isArray(computer.teachSteps)
      ? computer.teachSteps.map(parseTeachStep).filter((item): item is TeachStep => item !== null)
      : []
    if (prev.length >= MAX_STEPS) return { type: 'ignored' as const }
    computer.teachSteps = [...prev, step]
    await tx.botRun.update({ where: { id: runId }, data: { computer: computer as object } })
    return { type: 'recorded' as const, step }
  })
  if (outcome.type === 'missing') return { ok: false, status: 404, error: 'Bot run not found' }
  if (outcome.type === 'invalid') return { ok: false, status: 400, error: 'Invalid teach step', code: 'invalid_request' }
  if (outcome.type === 'recorded') {
    noteTeachStep(runId, outcome.step)
    return { ok: true, stored: true }
  }
  return { ok: true, stored: false }
}
