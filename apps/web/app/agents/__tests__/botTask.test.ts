import { describe, expect, it, vi } from 'vitest'
import {
  allowedToolsForBot,
  anyTaskInProgress,
  botMemoryQueryKey,
  computerForBot,
  computerForSend,
  computerUnavailableMessage,
  finishWatchTarget,
  listPanelPhase,
  resolveWatchTarget,
  routineScheduleLabel,
  routineSkillLabel,
  taskInProgress,
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

  it('keeps polling when a live task asked for a computer and the route 404s', async () => {
    const missing = Object.assign(new Error('not found'), { status: 404 })
    const target = await resolveWatchTarget('task-404', {
      getTask: async () => ({
        status: 'processing',
        computer: { enabled: true, ttlMinutes: 30 },
        runs: [{ id: 'run-404' }],
      }),
      getComputer: async () => { throw missing },
    })
    expect(target.starting).toBe(true)
    expect(target.noComputer).toBeFalsy()
    expect(target.runId).toBe('run-404')
    expect(target.viewUrl).toBeNull()
  })

  it('treats a missing sandbox as no computer when the task never asked for one', async () => {
    const missing = Object.assign(new Error('not found'), { status: 404 })
    const target = await resolveWatchTarget('task-plain', {
      getTask: async () => ({ status: 'processing', computer: null, runs: [{ id: 'run-plain' }] }),
      getComputer: async () => { throw missing },
    })
    expect(target.starting).toBe(false)
    expect(target.noComputer).toBe(true)
  })

  it('does not open a finished computer that still has a dead view url', async () => {
    const target = await resolveWatchTarget('task-dead', {
      getTask: async () => ({
        status: 'failed',
        computer: { enabled: true },
        runs: [{ id: 'run-dead' }],
      }),
      getComputer: async () => ({
        active: false,
        viewUrl: '/novnc/dead',
        interactiveUrl: null,
      }),
    })
    expect(target.viewUrl).toBeNull()
    expect(target.interactiveUrl).toBeNull()
    expect(target.starting).toBe(false)
    expect(target.timedOut).toBe(true)
  })

  it('keeps polling when the latest computer ended but the task is still live', async () => {
    const target = await resolveWatchTarget('task-retry', {
      getTask: async () => ({
        status: 'processing',
        computer: { enabled: true },
        runs: [{ id: 'run-retry' }],
      }),
      getComputer: async () => ({
        active: false,
        viewUrl: '/novnc/dead',
        interactiveUrl: null,
      }),
    })
    expect(target.viewUrl).toBeNull()
    expect(target.starting).toBe(true)
    expect(target.timedOut).toBeFalsy()
  })

  it('treats a finished run that never got a sandbox as no computer', async () => {
    const missing = Object.assign(new Error('not found'), { status: 404 })
    const target = await resolveWatchTarget('task-done', {
      getTask: async () => ({
        status: 'succeeded',
        computer: { enabled: true },
        runs: [{ id: 'run-done' }],
      }),
      getComputer: async () => { throw missing },
    })
    expect(target.starting).toBe(false)
    expect(target.noComputer).toBe(true)
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

describe('scheduled task progress', () => {
  const waiting = {
    status: 'queued' as const,
    kind: 'scheduled' as const,
    nextAttemptAt: '2099-01-01T00:00:00.000Z',
  }

  it('treats a future queued routine as waiting, not in progress', () => {
    expect(taskInProgress(waiting, Date.parse('2026-10-24T12:00:00.000Z'))).toBe(false)
    expect(taskInProgress({ ...waiting, status: 'processing' }, Date.parse('2026-10-24T12:00:00.000Z'))).toBe(true)
    expect(taskInProgress({
      ...waiting,
      nextAttemptAt: '2026-10-24T12:00:00.000Z',
    }, Date.parse('2026-10-24T12:00:00.000Z'))).toBe(true)
    expect(taskInProgress({ status: 'queued', kind: 'ops', nextAttemptAt: waiting.nextAttemptAt })).toBe(true)
  })

  it('ignores routines that are only waiting for the next interval', () => {
    expect(anyTaskInProgress([
      waiting,
      { status: 'succeeded', kind: 'ops', nextAttemptAt: waiting.nextAttemptAt },
    ], Date.parse('2026-10-24T12:00:00.000Z'))).toBe(false)
    expect(anyTaskInProgress([
      waiting,
      { status: 'processing', kind: 'ops', nextAttemptAt: waiting.nextAttemptAt },
    ], Date.parse('2026-10-24T12:00:00.000Z'))).toBe(true)
  })
})

describe('computer send gate', () => {
  it('drops the computer when the provider is off or the plan has no minutes', () => {
    expect(computerForSend(true, { computerAllowed: false, computerConfigured: true })).toBeUndefined()
    expect(computerForSend(true, { computerAllowed: true, computerConfigured: false })).toBeUndefined()
    expect(computerForSend(true, { computerAllowed: true, computerConfigured: true })).toEqual({ enabled: true, ttlMinutes: 30 })
    expect(computerForSend(false, { computerAllowed: true, computerConfigured: true })).toBeUndefined()
    expect(computerUnavailableMessage({ computerAllowed: false, computerConfigured: true }))
      .toMatch(/computer minutes/i)
    expect(computerUnavailableMessage({ computerAllowed: true, computerConfigured: false }))
      .toMatch(/not configured/i)
    expect(computerUnavailableMessage({ computerAllowed: true, computerConfigured: true })).toBeNull()
  })
})

describe('list panel phase', () => {
  it('treats an error as an error and null data as ready, not loading', () => {
    expect(listPanelPhase({ isPending: false, isError: true, data: null })).toBe('error')
    expect(listPanelPhase({ isPending: true, isError: false, data: null })).toBe('loading')
    expect(listPanelPhase({ isPending: false, isError: false, data: null })).toBe('ready')
    expect(listPanelPhase({ isPending: false, isError: false, data: [] })).toBe('ready')
  })
})

describe('bot memory query', () => {
  it('uses the bot memory cache key', () => {
    expect(botMemoryQueryKey('bot-9')).toEqual(['bot', 'memory', 'bot-9'])
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
