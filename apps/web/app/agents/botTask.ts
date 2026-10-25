/**
 * Send and Watch helpers for /agents.
 * BOT_RUNNER_TOOLS is what this client will put on a task. execute_code is
 * granted when the bot lists it and the runner exposes it. generate_image
 * stays out.
 */

export const BOT_RUNNER_TOOLS = [
  'web_search', 'web_fetch', 'create_document',
  'calculator', 'get_current_time', 'remember', 'search_knowledge',
  'execute_code',
] as const

export function allowedToolsForBot(defaultTools: readonly string[] | null | undefined): string[] {
  const grant = new Set<string>(BOT_RUNNER_TOOLS)
  const names: string[] = []
  for (const name of defaultTools ?? []) {
    if (!grant.has(name) || names.includes(name)) continue
    names.push(name)
  }
  return names
}

/** Dedicated computer only when this bot is marked for one. */
export function computerForBot(cloudComputer: boolean | undefined): { enabled: true; ttlMinutes: 30 } | undefined {
  return cloudComputer === true ? { enabled: true, ttlMinutes: 30 } : undefined
}

/** Drop the computer when this account cannot start one. An unknown quota still asks. */
export function computerForSend(
  cloudComputer: boolean | undefined,
  quota: { computerAllowed: boolean; computerConfigured: boolean } | null | undefined,
): { enabled: true; ttlMinutes: 30 } | undefined {
  const computer = computerForBot(cloudComputer)
  if (!computer || !quota) return computer
  if (!quota.computerAllowed || !quota.computerConfigured) return undefined
  return computer
}

/** Why a desktop cannot start, or null when this account can use one. */
export function computerUnavailableMessage(
  quota: { computerAllowed: boolean; computerConfigured: boolean } | null | undefined,
): string | null {
  if (!quota) return null
  if (!quota.computerConfigured) return 'Computer provider is not configured on this deployment.'
  if (!quota.computerAllowed) return 'Dedicated computer requires a plan with computer minutes.'
  return null
}

type ProgressTask = { status: string; kind?: string | null; nextAttemptAt?: string | null }

/** A scheduled task is in progress only while processing, or while queued and due. */
export function taskInProgress(task: ProgressTask, now = Date.now()): boolean {
  if (task.status === 'processing') return true
  if (task.status !== 'queued') return false
  if (task.kind !== 'scheduled') return true
  const due = task.nextAttemptAt ? Date.parse(task.nextAttemptAt) : Number.NaN
  if (Number.isNaN(due)) return true
  return due <= now
}

export function anyTaskInProgress(tasks: readonly ProgressTask[] | null | undefined, now = Date.now()): boolean {
  return !!tasks?.some((task) => taskInProgress(task, now))
}

/** Pending is loading. An error stays an error. Settled null data is ready. */
export function listPanelPhase(query: { isPending: boolean; isError: boolean; data: unknown }): 'loading' | 'error' | 'ready' {
  if (query.isError) return 'error'
  if (query.isPending) return 'loading'
  return 'ready'
}

export function botMemoryQueryKey(botId: string) {
  return ['bot', 'memory', botId] as const
}

export interface WatchTarget {
  taskId: string
  runId: string | null
  viewUrl: string | null
  interactiveUrl: string | null
  /** True only while a desktop may still appear. A 404 is not this. */
  starting: boolean
  /** The run has no computer (404 or the bot never had one). */
  noComputer?: boolean
  /** starting stayed true until the watch timeout. */
  timedOut?: boolean
}

/** How long Watch may sit on "starting" before it offers Trace. */
export const WATCH_START_TIMEOUT_MS = 45_000

function httpStatus(err: unknown): number | undefined {
  if (!err || typeof err !== 'object' || !('status' in err)) return undefined
  const status = (err as { status?: unknown }).status
  return typeof status === 'number' ? status : undefined
}

/** Stop a watch that will never get a stream. A live URL wins over the timeout. */
export function finishWatchTarget(target: WatchTarget, elapsedMs: number): WatchTarget {
  if (target.viewUrl || target.interactiveUrl) {
    return { ...target, starting: false, noComputer: false, timedOut: false }
  }
  if (target.noComputer) return { ...target, starting: false, timedOut: false }
  if (target.starting && elapsedMs >= WATCH_START_TIMEOUT_MS) {
    return { ...target, starting: false, timedOut: true }
  }
  return target
}

type WatchTask = {
  runs?: Array<{ id: string }> | null
  status?: string
  computer?: { enabled?: boolean } | null
}

type WatchComputer = {
  viewUrl?: string | null
  interactiveUrl?: string | null
  /** False means the VM is already gone. A leftover URL is not a live desktop. */
  active?: boolean
}

function desktopStillBooting(detail: WatchTask): boolean {
  const live = detail.status === 'queued' || detail.status === 'processing'
  return live && detail.computer?.enabled === true
}

export async function resolveWatchTarget(
  taskId: string,
  load: {
    getTask: (id: string) => Promise<WatchTask>
    getComputer: (runId: string) => Promise<WatchComputer | null>
  },
): Promise<WatchTarget> {
  let runId: string | null = null
  let detail: WatchTask = {}
  try {
    detail = await load.getTask(taskId)
    runId = detail.runs?.[0]?.id ?? null
  } catch (err) {
    if (httpStatus(err) === 404) {
      return { taskId, runId: null, viewUrl: null, interactiveUrl: null, starting: false, noComputer: true }
    }
    return { taskId, runId: null, viewUrl: null, interactiveUrl: null, starting: true }
  }
  if (!runId) return { taskId, runId: null, viewUrl: null, interactiveUrl: null, starting: true }
  const booting = desktopStillBooting(detail)
  try {
    const computer = await load.getComputer(runId)
    const live = computer?.active !== false
    const viewUrl = live ? computer?.viewUrl ?? null : null
    const interactiveUrl = live ? computer?.interactiveUrl ?? null : null
    if (!live) {
      if (booting) return { taskId, runId, viewUrl: null, interactiveUrl: null, starting: true }
      return { taskId, runId, viewUrl: null, interactiveUrl: null, starting: false, timedOut: true }
    }
    if (!viewUrl && !interactiveUrl && !computer) {
      if (booting) return { taskId, runId, viewUrl: null, interactiveUrl: null, starting: true }
      return { taskId, runId, viewUrl: null, interactiveUrl: null, starting: false, noComputer: true }
    }
    return { taskId, runId, viewUrl, interactiveUrl, starting: !viewUrl && !interactiveUrl }
  } catch (err) {
    if (httpStatus(err) === 404) {
      if (booting) return { taskId, runId, viewUrl: null, interactiveUrl: null, starting: true }
      return { taskId, runId, viewUrl: null, interactiveUrl: null, starting: false, noComputer: true }
    }
    return { taskId, runId, viewUrl: null, interactiveUrl: null, starting: true }
  }
}

const SCHEDULE_LABELS: Record<string, string> = {
  '30m': 'every 30 min',
  '2h': 'every 2 hours',
  '6h': 'every 6 hours',
  '1d': 'daily',
  '7d': 'weekly',
}

export function routineScheduleLabel(schedule: string): string {
  if (SCHEDULE_LABELS[schedule]) return SCHEDULE_LABELS[schedule]
  const match = /^(\d+)([mhd])$/.exec(schedule)
  if (!match) return schedule
  const n = Number(match[1])
  if (match[2] === 'd' && n === 1) return 'daily'
  if (match[2] === 'd' && n === 7) return 'weekly'
  const unit = match[2] === 'm'
    ? (n === 1 ? 'minute' : 'minutes')
    : match[2] === 'h'
      ? (n === 1 ? 'hour' : 'hours')
      : (n === 1 ? 'day' : 'days')
  return `every ${n} ${unit}`
}

export function routineSkillLabel(
  skillId: string | null | undefined,
  skills: Array<{ id: string; name: string }> | null,
): string | null {
  if (!skillId || !skills) return null
  return skills.find((skill) => skill.id === skillId)?.name ?? null
}
