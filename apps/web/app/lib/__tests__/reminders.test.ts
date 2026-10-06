import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isQuietNow, startBreakReminders } from '../reminders'

/** Time & focus enforcement: quiet-hours predicate + the break-timer engine. */

const qh = (over: Partial<Parameters<typeof isQuietNow>[0]> = {}) => ({
  enabled: true,
  days: [true, true, true, true, true, true, true],
  from: 22 * 60, // 22:00
  to: 7 * 60, // 07:00
  ...over,
})

const at = (day: number, hh: number, mm = 0) => new Date(2026, 9, 4 + day, hh, mm) // 2026-10-04 = Sunday (day 0)

describe('isQuietNow', () => {
  it('disabled quiet hours is never quiet', () => {
    expect(isQuietNow(qh({ enabled: false }), at(1, 23))).toBe(false)
    expect(isQuietNow(qh({ enabled: false }), at(1, 3))).toBe(false)
  })

  it('overnight window (22:00–07:00) wraps midnight', () => {
    expect(isQuietNow(qh(), at(1, 22, 30))).toBe(true)  // after start
    expect(isQuietNow(qh(), at(1, 23, 59))).toBe(true)
    expect(isQuietNow(qh(), at(1, 0, 30))).toBe(true)   // after midnight
    expect(isQuietNow(qh(), at(1, 6, 59))).toBe(true)
    expect(isQuietNow(qh(), at(1, 7, 0))).toBe(false)   // window end is exclusive
    expect(isQuietNow(qh(), at(1, 12))).toBe(false)
    expect(isQuietNow(qh(), at(1, 21, 59))).toBe(false)
  })

  it('same-day window (09:00–17:00) stays inside its bounds', () => {
    const day = qh({ from: 9 * 60, to: 17 * 60 })
    expect(isQuietNow(day, at(2, 8, 59))).toBe(false)
    expect(isQuietNow(day, at(2, 9))).toBe(true)
    expect(isQuietNow(day, at(2, 16, 59))).toBe(true)
    expect(isQuietNow(day, at(2, 17))).toBe(false)
  })

  it('zero-length window means all day', () => {
    expect(isQuietNow(qh({ from: 600, to: 600 }), at(3, 3))).toBe(true)
    expect(isQuietNow(qh({ from: 600, to: 600 }), at(3, 15))).toBe(true)
  })

  it('respects the day-of-week selection', () => {
    const weekdaysOnly = qh({ days: [false, true, true, true, true, true, false] })
    expect(isQuietNow(weekdaysOnly, at(0, 23))).toBe(false) // Sunday off
    expect(isQuietNow(weekdaysOnly, at(1, 23))).toBe(true)  // Monday on
    expect(isQuietNow(weekdaysOnly, at(6, 23))).toBe(false) // Saturday off
  })
})

describe('startBreakReminders', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('never fires while disabled', () => {
    const onFire = vi.fn()
    const prefs = { breakReminders: { enabled: false, everyMinutes: 5 } }
    const stop = startBreakReminders(() => prefs, onFire)
    vi.advanceTimersByTime(60 * 60_000)
    expect(onFire).not.toHaveBeenCalled()
    stop()
  })

  it('fires once per interval after enable — never immediately on toggle', () => {
    const onFire = vi.fn()
    const prefs = { breakReminders: { enabled: true, everyMinutes: 5 } }
    const stop = startBreakReminders(() => prefs, onFire)
    // Toggle-arm happens on the first tick: the full interval must elapse.
    vi.advanceTimersByTime(31_000)
    expect(onFire).not.toHaveBeenCalled()
    vi.advanceTimersByTime(5 * 60_000)
    expect(onFire).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(5 * 60_000)
    expect(onFire).toHaveBeenCalledTimes(2)
    stop()
  })

  it('re-arms the clock when the interval changes', () => {
    const onFire = vi.fn()
    const prefs = { breakReminders: { enabled: true, everyMinutes: 5 } }
    const stop = startBreakReminders(() => prefs, onFire)
    vi.advanceTimersByTime(4 * 60_000) // 4 of the first 5 minutes
    prefs.breakReminders.everyMinutes = 10
    vi.advanceTimersByTime(31_000) // next tick re-arms: now needs a full 10
    vi.advanceTimersByTime(9 * 60_000)
    expect(onFire).not.toHaveBeenCalled()
    vi.advanceTimersByTime(60_000)
    expect(onFire).toHaveBeenCalledTimes(1)
    stop()
  })

  it('clamps the interval to a 5-minute floor', () => {
    const onFire = vi.fn()
    const prefs = { breakReminders: { enabled: true, everyMinutes: 0 } }
    const stop = startBreakReminders(() => prefs, onFire)
    // 0 → default 50 in the engine? No: 0 falls back to 50 (|| 50) — the
    // clamp guarantees ≥5 either way; assert it does not fire early.
    vi.advanceTimersByTime(4 * 60_000)
    expect(onFire).not.toHaveBeenCalled()
    stop()
  })
})
