/**
 * Routine schedule presets, IANA timezone, and the 7-day away pause.
 * Legacy 30m / 6h / 1d intervals stay valid.
 */

export const AWAY_AFTER_MS = 7 * 24 * 60 * 60 * 1000

const LEGACY = /^(\d+)([mhd])$/
const PRESET = /^(?:hourly|daily@(\d{2}):(\d{2})|weekdays@(\d{2}):(\d{2})|weekly:(mon|tue|wed|thu|fri|sat|sun)@(\d{2}):(\d{2}))$/
const BOUNDS: Record<string, [number, number]> = {
  m: [5 * 60_000, 10_080 * 60_000],
  h: [60 * 60_000, 168 * 60 * 60_000],
  d: [24 * 60 * 60_000, 30 * 24 * 60 * 60_000],
}
const UNIT: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000 }
const WEEK = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

export interface ParsedSchedule {
  expr: string
  timeZone: string
  autoPauseWhenAway: boolean
}

export function parseRoutineSchedule(raw: string): ParsedSchedule {
  const parts = String(raw || '').split('|')
  let timeZone = 'UTC'
  let autoPauseWhenAway = false
  for (const part of parts.slice(1)) {
    if (part === 'away') autoPauseWhenAway = true
    else if (part) timeZone = part
  }
  return { expr: parts[0] || '', timeZone, autoPauseWhenAway }
}

function legacyMs(expr: string): number | null {
  const match = LEGACY.exec(expr)
  if (!match) return null
  const n = Number(match[1])
  const ms = n * UNIT[match[2]]
  const [min, max] = BOUNDS[match[2]]
  if (!Number.isSafeInteger(ms) || ms < min || ms > max) return null
  return ms
}

function clockOk(hour: string, minute: string): boolean {
  const h = Number(hour)
  const m = Number(minute)
  return h >= 0 && h <= 23 && m >= 0 && m <= 59
}

export function isValidSchedule(schedule: string): boolean {
  const { expr, timeZone } = parseRoutineSchedule(schedule)
  if (!expr) return false
  try { Intl.DateTimeFormat('en-US', { timeZone }) } catch { return false }
  if (legacyMs(expr) != null) return true
  const match = PRESET.exec(expr)
  if (!match) return false
  const hours = [match[1], match[3], match[6]].filter(Boolean)
  const minutes = [match[2], match[4], match[7]].filter(Boolean)
  if (!hours.length) return expr === 'hourly'
  return hours.every((h, i) => clockOk(h, minutes[i] || '00'))
}

function zonedParts(date: Date, timeZone: string): Record<string, string> {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
  const map: Record<string, string> = {}
  for (const part of fmt.formatToParts(date)) map[part.type] = part.value
  if (map.hour === '24') map.hour = '00'
  return map
}

function offsetMs(date: Date, timeZone: string): number {
  const p = zonedParts(date, timeZone)
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second)
  return asUtc - date.getTime()
}

function zonedToUtc(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): Date {
  const guess = new Date(Date.UTC(year, month - 1, day, hour, minute, 0))
  const first = new Date(guess.getTime() - offsetMs(guess, timeZone))
  return new Date(guess.getTime() - offsetMs(first, timeZone))
}

function weekdayKey(short: string): string {
  const map: Record<string, string> = { Sun: 'sun', Mon: 'mon', Tue: 'tue', Wed: 'wed', Thu: 'thu', Fri: 'fri', Sat: 'sat' }
  return map[short] || short.toLowerCase().slice(0, 3)
}

function nextWall(from: Date, timeZone: string, hour: number, minute: number, days: Set<string> | null): Date {
  const start = zonedParts(from, timeZone)
  let year = +start.year
  let month = +start.month
  let day = +start.day
  for (let i = 0; i < 21; i++) {
    const candidate = zonedToUtc(year, month, day, hour, minute, timeZone)
    const parts = zonedParts(candidate, timeZone)
    const dayOk = !days || days.has(weekdayKey(parts.weekday))
    if (candidate.getTime() > from.getTime() && +parts.hour === hour && +parts.minute === minute && dayOk) return candidate
    const noon = zonedToUtc(year, month, day, 12, 0, timeZone)
    const next = zonedParts(new Date(noon.getTime() + 24 * 60 * 60 * 1000), timeZone)
    year = +next.year
    month = +next.month
    day = +next.day
  }
  return new Date(from.getTime() + 24 * 60 * 60 * 1000)
}

export function parseScheduleNext(schedule: string, timeZone: string, from: Date): Date {
  const parsed = parseRoutineSchedule(schedule)
  const zone = parsed.timeZone && parsed.timeZone !== 'UTC' ? parsed.timeZone : (timeZone || 'UTC')
  const legacy = legacyMs(parsed.expr)
  if (legacy != null) return new Date(from.getTime() + legacy)
  if (parsed.expr === 'hourly') return new Date(from.getTime() + 60 * 60 * 1000)
  let match = /^daily@(\d{2}):(\d{2})$/.exec(parsed.expr)
  if (match) return nextWall(from, zone, +match[1], +match[2], null)
  match = /^weekdays@(\d{2}):(\d{2})$/.exec(parsed.expr)
  if (match) return nextWall(from, zone, +match[1], +match[2], new Set(['mon', 'tue', 'wed', 'thu', 'fri']))
  match = /^weekly:(mon|tue|wed|thu|fri|sat|sun)@(\d{2}):(\d{2})$/.exec(parsed.expr)
  if (match) return nextWall(from, zone, +match[2], +match[3], new Set([match[1]]))
  return new Date(from.getTime() + 24 * 60 * 60 * 1000)
}

export function scheduleDelayMs(schedule: string, from = new Date(), timeZone = 'UTC'): number {
  const legacy = legacyMs(parseRoutineSchedule(schedule).expr)
  if (legacy != null) return legacy
  return Math.max(60_000, parseScheduleNext(schedule, timeZone, from).getTime() - from.getTime())
}

export function formatNextRun(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    minute: '2-digit',
  }).format(date)
}

export function awayRoutineIds(
  routines: Array<{ id: string; autoPauseWhenAway: boolean; paused: boolean }>,
  lastActiveAt: Date,
  now: Date,
): string[] {
  if (now.getTime() - lastActiveAt.getTime() <= AWAY_AFTER_MS) return []
  return routines.filter((routine) => routine.autoPauseWhenAway && !routine.paused).map((routine) => routine.id)
}

export function routineTranscript(goal: string, result: string): { role: 'assistant'; content: string } {
  return { role: 'assistant', content: `Routine result for “${goal}”:\n\n${result}` }
}

export const WEEKDAY_KEYS = WEEK
