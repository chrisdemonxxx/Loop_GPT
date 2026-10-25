/**
 * Send and Watch helpers for /agents.
 * BOT_RUNNER_TOOLS mirrors backend BOT_DEFAULT_TOOLS. execute_code and
 * generate_image stay out of that list, so a bot cannot receive them here.
 */

export const BOT_RUNNER_TOOLS = [
  'web_search', 'web_fetch', 'create_document',
  'calculator', 'get_current_time', 'remember', 'search_knowledge',
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

export interface WatchTarget {
  taskId: string
  runId: string | null
  viewUrl: string | null
  interactiveUrl: string | null
  /** True until the run's desktop stream exists. */
  starting: boolean
}

export async function resolveWatchTarget(
  taskId: string,
  load: {
    getTask: (id: string) => Promise<{ runs?: Array<{ id: string }> | null }>
    getComputer: (runId: string) => Promise<{ viewUrl?: string | null; interactiveUrl?: string | null } | null>
  },
): Promise<WatchTarget> {
  let runId: string | null = null
  try {
    const detail = await load.getTask(taskId)
    runId = detail.runs?.[0]?.id ?? null
  } catch {
    return { taskId, runId: null, viewUrl: null, interactiveUrl: null, starting: true }
  }
  if (!runId) return { taskId, runId: null, viewUrl: null, interactiveUrl: null, starting: true }
  try {
    const computer = await load.getComputer(runId)
    const viewUrl = computer?.viewUrl ?? null
    const interactiveUrl = computer?.interactiveUrl ?? null
    return { taskId, runId, viewUrl, interactiveUrl, starting: !viewUrl && !interactiveUrl }
  } catch {
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
