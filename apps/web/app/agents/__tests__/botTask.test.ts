import { describe, expect, it, vi } from 'vitest'
import {
  allowedToolsForBot,
  computerForBot,
  finishWatchTarget,
  resolveWatchTarget,
  routineScheduleLabel,
  routineSkillLabel,
  WATCH_START_TIMEOUT_MS,
} from '../botTask'

describe('allowedToolsForBot', () => {
  it('includes execute_code when the bot lists it and drops generate_image', () => {
    expect(allowedToolsForBot([
      'web_search', 'execute_code', 'generate_image', 'web_fetch', 'web_search',
    ])).toEqual(['web_search', 'execute_code', 'web_fetch'])
  })

  it('lets a bot whose only tool is execute_code send', () => {
    expect(allowedToolsForBot(['execute_code'])).toEqual(['execute_code'])
    expect(allowedToolsForBot(['generate_image'])).toEqual([])
    expect(allowedToolsForBot(undefined)).toEqual([])
  })
})

describe('computerForBot', () => {
  it('enables a computer only when the bot asks for one', () => {
    expect(computerForBot(true)).toEqual({ enabled: true, ttlMinutes: 30 })
    expect(computerForBot(false)).toBeUndefined()
    expect(computerForBot(undefined)).toBeUndefined()
  })
})

describe('resolveWatchTarget', () => {
  it('keeps the task id and loads the run computer', async () => {
    const getTask = vi.fn(async () => ({ runs: [{ id: 'run-7' }] }))
    const getComputer = vi.fn(async () => ({ viewUrl: '/view', interactiveUrl: null }))
    const target = await resolveWatchTarget('task-7', { getTask, getComputer })
    expect(getTask).toHaveBeenCalledWith('task-7')
    expect(getComputer).toHaveBeenCalledWith('run-7')
    expect(target).toEqual({
      taskId: 'task-7',
      runId: 'run-7',
      viewUrl: '/view',
      interactiveUrl: null,
      starting: false,
    })
  })

  it('does not leave a missing stream starting forever', async () => {
    const getComputer = vi.fn(async () => ({ viewUrl: null, interactiveUrl: null }))
    const target = await resolveWatchTarget('task-8', {
      getTask: async () => ({ runs: [{ id: 'run-8' }] }),
      getComputer,
    })
    expect(target.taskId).toBe('task-8')
    expect(target.runId).toBe('run-8')
    expect(target.starting).toBe(true)
    expect(finishWatchTarget(target, 0).timedOut).toBeFalsy()
    const done = finishWatchTarget(target, WATCH_START_TIMEOUT_MS)
    expect(done.starting).toBe(false)
    expect(done.timedOut).toBe(true)
  })

  it('does not stay starting when the computer route 404s', async () => {
    const missing = Object.assign(new Error('not found'), { status: 404 })
    const target = await resolveWatchTarget('task-404', {
      getTask: async () => ({ runs: [{ id: 'run-404' }] }),
      getComputer: async () => { throw missing },
    })
    expect(target.starting).toBe(false)
    expect(target.noComputer).toBe(true)
    expect(target.runId).toBe('run-404')
    expect(target.viewUrl).toBeNull()
  })

  it('keeps the task id when no run exists yet', async () => {
    const getComputer = vi.fn()
    const target = await resolveWatchTarget('task-9', {
      getTask: async () => ({ runs: [] }),
      getComputer,
    })
    expect(getComputer).not.toHaveBeenCalled()
    expect(target).toMatchObject({ taskId: 'task-9', runId: null, starting: true })
  })
})

describe('routine labels', () => {
  it('maps 1d to daily and prefers the skill name', () => {
    expect(routineScheduleLabel('1d')).toBe('daily')
    expect(routineScheduleLabel('7d')).toBe('weekly')
    expect(routineSkillLabel('sk-1', [{ id: 'sk-1', name: 'Checkout' }])).toBe('Checkout')
    expect(routineSkillLabel('sk-1', null)).toBeNull()
    expect(routineSkillLabel('missing', [{ id: 'sk-1', name: 'Checkout' }])).toBeNull()
  })
})
