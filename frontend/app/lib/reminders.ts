'use client'

/**
 * Time & focus enforcement (redesign decision: make the tab REAL — it used to
 * be toggles that saved locally and did nothing).
 *
 *  - isQuietNow: quiet-hours predicate (day-of-week + window, overnight-safe)
 *  - notify: one wrapper for every app notification — quiet-hours gate first,
 *    then the Notification API (permission asked lazily), status returned so
 *    the caller can fall back to a toast.
 *  - startBreakReminders: the break-timer engine (interval, pref-driven).
 */

export interface QuietHoursPrefs {
  enabled: boolean
  /** Sun..Sat (index 0 = Sunday). */
  days: boolean[]
  /** Minutes from midnight, local time. */
  from: number
  to: number
}

export interface BreakRemindersPrefs {
  enabled: boolean
  everyMinutes: number
}

/** True when `date` falls inside the quiet-hours window. Overnight windows
 *  (from > to, e.g. 22:00–07:00) wrap midnight correctly. */
export function isQuietNow(q: QuietHoursPrefs, date = new Date()): boolean {
  if (!q.enabled) return false
  if (!q.days[date.getDay()]) return false
  const mins = date.getHours() * 60 + date.getMinutes()
  if (q.from === q.to) return true // "all day" when the window is zero-length
  if (q.from < q.to) return mins >= q.from && mins < q.to
  return mins >= q.from || mins < q.to // overnight: 22:00–07:00
}

export type NotifyResult = 'sent' | 'quiet' | 'denied' | 'unsupported'

/** Fire a user-visible notification unless quiet hours say no. */
export async function notify(
  quietHours: QuietHoursPrefs,
  title: string,
  body: string,
): Promise<NotifyResult> {
  if (isQuietNow(quietHours)) return 'quiet'
  if (typeof Notification === 'undefined') return 'unsupported'
  if (Notification.permission === 'denied') return 'denied'
  if (Notification.permission === 'default') {
    try { await Notification.requestPermission() } catch { /* older impls sync */ }
  }
  if (Notification.permission !== 'granted') return 'denied'
  try {
    new Notification(title, { body, icon: '/icon.svg', tag: 'loop-reminder' })
    return 'sent'
  } catch {
    return 'unsupported'
  }
}

export type ReminderFire = (kind: 'break') => void

/**
 * The break-reminder engine. Reads prefs through `getPrefs` (so toggles apply
 * live), checks every 30s, fires `onFire('break')` when the interval elapses.
 * The clock restarts on (re)enable and on every interval change.
 * Returns a stop function. Pure client-side; a no-op off-window.
 */
export function startBreakReminders(
  getPrefs: () => { breakReminders: BreakRemindersPrefs },
  onFire: ReminderFire,
): () => void {
  let nextFire = 0
  let lastEnabled = false
  let lastEvery = 0
  const tick = () => {
    const { breakReminders: b } = getPrefs()
    const everyMs = Math.max(5, b.everyMinutes || 50) * 60_000
    const now = Date.now()
    if (!b.enabled) { lastEnabled = false; return }
    if (!lastEnabled || lastEvery !== everyMs) {
      // (Re)enabled or interval changed: the next reminder is one full
      // interval out — never fire immediately on toggle.
      nextFire = now + everyMs
      lastEnabled = true
      lastEvery = everyMs
      return
    }
    if (now >= nextFire) {
      nextFire = now + everyMs
      onFire('break')
    }
  }
  const timer = setInterval(tick, 30_000)
  tick()
  return () => clearInterval(timer)
}
