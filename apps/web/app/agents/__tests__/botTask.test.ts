import { describe, expect, it, vi } from 'vitest'
import {
  allowedToolsForBot,
  computerForBot,
  resolveWatchTarget,
  routineScheduleLabel,
  routineSkillLabel,
} from '../botTask'

describe('allowedToolsForBot', () => {
  it('intersects the bot tools with the runner grant and drops execute_code and generate_image', () => {
    expect(allowedToolsForBot([
      'web_search', 'execute_code', 'generate_image', 'web_fetch', 'web_search',
    ])).toEqual(['web_search', 'web_fetch'])
  })

  it('returns an empty grant when every listed tool is outside the runner set', () => {
    expect(allowedToolsForBot(['execute_code', 'generate_image'])).toEqual([])
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

  it('says the desktop is still starting when the run has no stream', async () => {
    const getComputer = vi.fn(async () => ({ viewUrl: null, interactiveUrl: null }))
    const target = await resolveWatchTarget('task-8', {
      getTask: async () => ({ runs: [{ id: 'run-8' }] }),
      getComputer,
    })
    expect(target.taskId).toBe('task-8')
    expect(target.runId).toBe('run-8')
    expect(target.starting).toBe(true)
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
