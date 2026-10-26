import { describe, expect, it } from 'vitest'
import { AWAY_AFTER_MS, awayRoutineIds, formatNextRun, isValidSchedule, parseScheduleNext, routineTranscript, scheduleDelayMs } from '../routineSchedule'

describe('routine schedules', () => {
  it('keeps legacy intervals and presets, and reports the next run in the chosen zone', () => {
    const from = new Date('2026-03-07T12:00:00.000Z')
    expect(scheduleDelayMs('30m', from)).toBe(30 * 60_000)
    expect(scheduleDelayMs('6h', from)).toBe(6 * 60 * 60_000)
    expect(isValidSchedule('daily@09:30|America/New_York|away')).toBe(true)
    expect(isValidSchedule('15 minutes')).toBe(false)

    const beforeDst = parseScheduleNext('daily@09:30|America/New_York', 'UTC', from)
    expect(beforeDst.toISOString()).toBe('2026-03-07T14:30:00.000Z')

    const afterDst = parseScheduleNext('daily@09:30|America/New_York', 'UTC', new Date('2026-03-08T12:00:00.000Z'))
    expect(afterDst.toISOString()).toBe('2026-03-08T13:30:00.000Z')

    expect(formatNextRun(beforeDst, 'America/New_York')).toMatch(/9:30/)
  })

  it('pauses away routines after 7 days and leaves the others', () => {
    expect(AWAY_AFTER_MS).toBe(7 * 24 * 60 * 60 * 1000)
    const now = new Date('2026-10-25T00:00:00.000Z')
    const ids = awayRoutineIds([
      { id: 'a', autoPauseWhenAway: true, paused: false },
      { id: 'b', autoPauseWhenAway: false, paused: false },
      { id: 'c', autoPauseWhenAway: true, paused: true },
    ], new Date('2026-10-17T00:00:00.000Z'), now)
    expect(ids).toEqual(['a'])
    expect(awayRoutineIds([{ id: 'a', autoPauseWhenAway: true, paused: false }], new Date('2026-10-20T00:00:00.000Z'), now)).toEqual([])
  })

  it('posts the routine result as a transcript line', () => {
    expect(routineTranscript('Check deploys', 'All green')).toEqual({
      role: 'assistant',
      content: 'Routine result for “Check deploys”:\n\nAll green',
    })
  })
})
