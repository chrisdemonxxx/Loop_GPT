/**
 * Teach recording: create_skill before distill must not emit skill_saved,
 * and an empty demonstration must not create a skill.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const findUniqueTask = vi.fn()
const findUniqueUser = vi.fn()
const findFirstConversation = vi.fn()
const runAgent = vi.fn()
const completeAgentTask = vi.fn()
const failAgentTask = vi.fn()
const renewAgentTaskLease = vi.fn()
const isCancelRequested = vi.fn()
const remainingVmMinutes = vi.fn()
const startRun = vi.fn()
const setRunComputer = vi.fn()
const isRunTakeoverRequested = vi.fn()
const authorizeRunContext = vi.fn()
const saveMessage = vi.fn()
const reserveDailyCredits = vi.fn()
const captureDailyReservation = vi.fn()
const cleanupDailyReservation = vi.fn()
const dailyDispatch = vi.fn()
const attachUserBoxFromDB = vi.fn()
const createBoxTaskFolder = vi.fn()
const computerStart = vi.fn()
const attachDesktop = vi.fn()
const ensurePersonalWorkspace = vi.fn()
const saveArtifact = vi.fn()

vi.mock('../prisma', () => ({
  hasDb: true,
  prisma: {
    agentTask: { findUnique: (...args: unknown[]) => findUniqueTask(...args) },
    user: { findUnique: (...args: unknown[]) => findUniqueUser(...args) },
    conversation: { findFirst: (...args: unknown[]) => findFirstConversation(...args), create: vi.fn() },
    botBox: { findUnique: vi.fn(async () => null) },
    botRun: { findUnique: vi.fn(async () => ({ computer: null })) },
  },
}))

vi.mock('../../agent/agentRuntime', () => ({
  runAgent: (...args: unknown[]) => runAgent(...args),
}))

vi.mock('../../agent', () => ({
  availableTools: () => [{
    name: 'web_search',
    source: 'builtin',
    description: 'search',
    parameters: { type: 'object', properties: {} },
    handler: async () => ({ content: 'ok' }),
  }],
  toolRegistry: {
    get: (name: string) => name === 'create_skill' ? {
      name: 'create_skill',
      source: 'builtin',
      description: 'create a skill',
      parameters: { type: 'object', properties: {} },
      handler: async () => ({ content: 'ok' }),
    } : undefined,
  },
  builtinToolNames: () => ['web_search'],
}))

vi.mock('../../agent/runAuthorization', () => ({
  authorizeRunContext: (...args: unknown[]) => authorizeRunContext(...args),
}))

vi.mock('../../agent/tools/computerTools', () => ({
  COMPUTER_TOOLS: [],
  COMPUTER_TOOL_NAMES: [],
  computerToolsForScreen: () => [],
}))

vi.mock('../../agent/skills/skillLoader', () => ({
  loadSkillsForUser: () => [],
}))

vi.mock('../../agent/artifacts', () => ({
  saveArtifact: (...args: unknown[]) => saveArtifact(...args),
}))

vi.mock('../../agent/guardrails', () => ({
  sanitizeMetadata: (v: unknown) => v,
}))

vi.mock('../workspaces', () => ({
  ensurePersonalWorkspace: (...args: unknown[]) => ensurePersonalWorkspace(...args),
}))

vi.mock('../chatStore', () => ({
  saveMessage: (...args: unknown[]) => saveMessage(...args),
}))

vi.mock('../billing', () => ({
  estimateTokens: () => 3,
}))

vi.mock('../dailyReservations', () => ({
  DailyCreditError: class extends Error {},
  reserveDailyCredits: (...args: unknown[]) => reserveDailyCredits(...args),
  captureDailyReservation: (...args: unknown[]) => captureDailyReservation(...args),
  cleanupDailyReservation: (...args: unknown[]) => cleanupDailyReservation(...args),
  dailyDispatch: (...args: unknown[]) => dailyDispatch(...args),
}))

vi.mock('../botRuns', () => ({
  startRun: (...args: unknown[]) => startRun(...args),
  setRunComputer: (...args: unknown[]) => setRunComputer(...args),
  isRunTakeoverRequested: (...args: unknown[]) => isRunTakeoverRequested(...args),
}))

vi.mock('../agentTasks', () => {
  class AgentTaskError extends Error {
    code: string
    constructor(code: string, message?: string) {
      super(message || code)
      this.code = code
    }
  }
  return {
    AgentTaskError,
    BOT_DEFAULT_TOOLS: ['web_search'],
    completeAgentTask: (...args: unknown[]) => completeAgentTask(...args),
    failAgentTask: (...args: unknown[]) => failAgentTask(...args),
    renewAgentTaskLease: (...args: unknown[]) => renewAgentTaskLease(...args),
    isCancelRequested: (...args: unknown[]) => isCancelRequested(...args),
    remainingVmMinutes: (...args: unknown[]) => remainingVmMinutes(...args),
  }
})

vi.mock('../botBox', () => ({
  attachUserBoxFromDB: (...args: unknown[]) => attachUserBoxFromDB(...args),
  createBoxTaskFolder: (...args: unknown[]) => createBoxTaskFolder(...args),
  extendUserBoxLease: vi.fn(async () => undefined),
  syncUserBoxNow: vi.fn(async () => undefined),
}))

vi.mock('../computerSession', () => ({
  ComputerSession: { start: (...args: unknown[]) => computerStart(...args) },
}))

vi.mock('../e2bDesktop', () => ({
  E2BDesktopError: class extends Error {
    code: string
    constructor(message: string, code: string) {
      super(message)
      this.code = code
    }
  },
  attachDesktop: (...args: unknown[]) => attachDesktop(...args),
}))

import { executeBotTask } from '../botRunner'
import { clearTeachSteps, noteTeachStep } from '../teachSteps'

const userId = 'user-teach-1'
const claim = { taskId: 'task-teach', leaseToken: 'lease-1', attempt: 1 }
const emit = vi.fn()
const failRun = vi.fn(async () => undefined)
const completeRun = vi.fn(async () => undefined)

function baseTask(overrides: Record<string, unknown> = {}) {
  return {
    id: 'task-teach',
    status: 'processing',
    cancelRequested: false,
    userId,
    model: 'test-model',
    allowedTools: ['web_search'],
    kind: 'teach',
    computer: { enabled: true, ttlMinutes: 10 },
    maxSteps: 5,
    thinking: null,
    botId: null,
    skillId: null,
    goal: 'Show how to search',
    ...overrides,
  }
}

function skillResult(id: string, name: string) {
  return {
    type: 'tool_result',
    step: 1,
    name: 'create_skill',
    content: 'saved',
    isError: false,
    data: { skill: { id, name } },
  }
}

function savedSkills() {
  return emit.mock.calls.map((call) => call[0]).filter((event) => event?.type === 'skill_saved')
}

function promptText(arg: { messages?: Array<{ content?: unknown }> }): string {
  const content = arg.messages?.[0]?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((part): part is { type: string; text?: string } => !!part && typeof part === 'object')
    .filter((part) => part.type === 'text')
    .map((part) => part.text || '')
    .join('\n')
}

function scriptTakeover(states: boolean[]) {
  let i = 0
  isRunTakeoverRequested.mockImplementation(async () => {
    const value = states[Math.min(i, states.length - 1)]
    i += 1
    return value
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  clearTeachSteps('run-1')
  findUniqueTask.mockResolvedValue(baseTask())
  findUniqueUser.mockResolvedValue({ id: userId })
  findFirstConversation.mockResolvedValue({ id: 'convo-1', userId, workspaceId: 'ws-1', title: 'Loop Bot' })
  ensurePersonalWorkspace.mockResolvedValue({ id: 'ws-1' })
  authorizeRunContext.mockImplementation(async (ctx: unknown) => ctx)
  renewAgentTaskLease.mockResolvedValue(true)
  isCancelRequested.mockResolvedValue(false)
  remainingVmMinutes.mockResolvedValue(60)
  completeAgentTask.mockResolvedValue('succeeded')
  failAgentTask.mockResolvedValue('dead_letter')
  reserveDailyCredits.mockResolvedValue({ id: 'res-1' })
  captureDailyReservation.mockResolvedValue(undefined)
  cleanupDailyReservation.mockResolvedValue(undefined)
  dailyDispatch.mockReturnValue(async () => undefined)
  attachUserBoxFromDB.mockResolvedValue(null)
  attachDesktop.mockRejectedValue(new Error('no live box'))
  createBoxTaskFolder.mockResolvedValue('/workspace/task-folders/task-teach')
  saveArtifact.mockResolvedValue({ id: 'art-1', kind: 'image', name: 'frame.png' })
  emit.mockReset()
  failRun.mockReset()
  completeRun.mockReset()
  startRun.mockResolvedValue({ runId: 'run-1', emit, complete: completeRun, fail: failRun })
  computerStart.mockResolvedValue({
    info: { sandboxId: 'sbx-fake', streamAuthKey: 'key', viewUrl: '/view', interactiveUrl: '/live' },
    screen: { width: 1366, height: 768 },
    minutes: () => 1,
    close: vi.fn(async () => undefined),
    captureSilent: vi.fn(async () => Buffer.from('png')),
  })
})

describe('teach record then distill', () => {
  it('ignores create_skill before distill and emits skill_saved only from the distill turn', async () => {
    noteTeachStep('run-1', { at: 1, kind: 'click', x: 640, y: 400 })
    noteTeachStep('run-1', { at: 2, kind: 'key', key: 'Enter' })
    noteTeachStep('run-1', { at: 3, kind: 'type', text: 'hello' })
    scriptTakeover([true, true, false])
    let phase = 0
    runAgent.mockImplementation(async (opts: { ctx: { emit: (e: unknown) => void } }) => {
      phase += 1
      if (phase === 1) {
        opts.ctx.emit(skillResult('sk-early', 'Too Soon'))
        opts.ctx.emit({ type: 'final', content: 'Ready', metadata: {} })
        return { content: 'Ready', steps: [], toolsUsed: [] }
      }
      opts.ctx.emit(skillResult('sk-real', 'Checkout'))
      opts.ctx.emit({ type: 'final', content: 'Saved Checkout', metadata: {} })
      return { content: 'Saved Checkout', steps: [], toolsUsed: ['create_skill'] }
    })

    const outcome = await executeBotTask(claim as any, { leaseMs: 60_000, teachPollMs: 0 })

    expect(outcome).toBe('succeeded')
    expect(runAgent).toHaveBeenCalledTimes(2)
    expect(runAgent.mock.calls[0][0].toolNames).not.toContain('create_skill')
    expect(runAgent.mock.calls[1][0].toolNames).toContain('create_skill')
    const distilled = promptText(runAgent.mock.calls[1][0])
    expect(distilled).toContain('click 640,400')
    expect(distilled).toContain('key Enter')
    expect(distilled).toContain('type hello')
    expect(savedSkills()).toEqual([{ type: 'skill_saved', skillId: 'sk-real', name: 'Checkout' }])
    expect(failAgentTask).not.toHaveBeenCalled()
  })

  it('does not create a skill when the demo has one frame and no input', async () => {
    scriptTakeover([true, false])
    runAgent.mockImplementation(async (opts: { ctx: { emit: (e: unknown) => void } }) => {
      opts.ctx.emit(skillResult('sk-early', 'Too Soon'))
      opts.ctx.emit({ type: 'final', content: 'Ready', metadata: {} })
      return { content: 'Ready', steps: [], toolsUsed: [] }
    })

    const outcome = await executeBotTask(claim as any, { leaseMs: 60_000, teachPollMs: 0 })

    expect(outcome).toBe('dead_letter')
    expect(runAgent).toHaveBeenCalledTimes(1)
    expect(runAgent.mock.calls[0][0].toolNames).not.toContain('create_skill')
    expect(savedSkills()).toEqual([])
    expect(failRun).toHaveBeenCalledWith(expect.stringMatching(/Nothing was recorded/))
    expect(failAgentTask).toHaveBeenCalledWith(claim, 'BOT_TEACH_NOTHING_RECORDED', 'Nothing was recorded')
    expect(completeAgentTask).not.toHaveBeenCalled()
    expect(cleanupDailyReservation).toHaveBeenCalledWith('res-1')
  })

  it('does not create a skill when frames were captured but no input steps arrived', async () => {
    scriptTakeover([true, true, false])
    runAgent.mockImplementation(async (opts: { ctx: { emit: (e: unknown) => void } }) => {
      opts.ctx.emit({ type: 'final', content: 'Ready', metadata: {} })
      return { content: 'Ready', steps: [], toolsUsed: [] }
    })

    const outcome = await executeBotTask(claim as any, { leaseMs: 60_000, teachPollMs: 0 })

    expect(outcome).toBe('dead_letter')
    expect(runAgent).toHaveBeenCalledTimes(1)
    expect(savedSkills()).toEqual([])
    expect(failAgentTask).toHaveBeenCalledWith(claim, 'BOT_TEACH_NOTHING_RECORDED', 'Nothing was recorded')
    const session = await computerStart.mock.results[0].value
    // Two polls while takeover is on, plus the release frame.
    expect(session.captureSilent).toHaveBeenCalledTimes(3)
  })

  it('distills one screenshot and one stored step', async () => {
    noteTeachStep('run-1', { at: 1, kind: 'click', x: 12, y: 34 })
    scriptTakeover([true, false])
    const captureSilent = vi.fn()
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValue(Buffer.from('png'))
    computerStart.mockResolvedValue({
      info: { sandboxId: 'sbx-fake', streamAuthKey: 'key', viewUrl: '/view', interactiveUrl: '/live' },
      screen: { width: 1366, height: 768 },
      minutes: () => 1,
      close: vi.fn(async () => undefined),
      captureSilent,
    })
    let phase = 0
    runAgent.mockImplementation(async (opts: { ctx: { emit: (e: unknown) => void } }) => {
      phase += 1
      if (phase === 1) {
        opts.ctx.emit({ type: 'final', content: 'Ready', metadata: {} })
        return { content: 'Ready', steps: [], toolsUsed: [] }
      }
      opts.ctx.emit(skillResult('sk-one', 'One Step'))
      opts.ctx.emit({ type: 'final', content: 'Saved', metadata: {} })
      return { content: 'Saved', steps: [], toolsUsed: ['create_skill'] }
    })

    const outcome = await executeBotTask(claim as any, { leaseMs: 60_000, teachPollMs: 0 })

    expect(outcome).toBe('succeeded')
    expect(runAgent).toHaveBeenCalledTimes(2)
    expect(captureSilent).toHaveBeenCalledTimes(2)
    const distilled = promptText(runAgent.mock.calls[1][0])
    expect(distilled).toContain('click 12,34')
    expect(distilled).toContain('1 frames were recorded')
    expect(savedSkills()).toEqual([{ type: 'skill_saved', skillId: 'sk-one', name: 'One Step' }])
    expect(failAgentTask).not.toHaveBeenCalled()
  })

  it('retries create_skill once when the distill turn does not save a skill', async () => {
    noteTeachStep('run-1', { at: 1, kind: 'click', x: 640, y: 400 })
    scriptTakeover([true, false])
    let phase = 0
    runAgent.mockImplementation(async (opts: { ctx: { emit: (e: unknown) => void } }) => {
      phase += 1
      if (phase < 3) {
        opts.ctx.emit({ type: 'final', content: phase === 1 ? 'Ready' : 'Described only', metadata: {} })
        return { content: 'No skill', steps: [], toolsUsed: [] }
      }
      opts.ctx.emit(skillResult('sk-retry', 'Retry'))
      opts.ctx.emit({ type: 'final', content: 'Saved', metadata: {} })
      return { content: 'Saved', steps: [], toolsUsed: ['create_skill'] }
    })

    const outcome = await executeBotTask(claim as any, { leaseMs: 60_000, teachPollMs: 0 })

    expect(outcome).toBe('succeeded')
    expect(runAgent).toHaveBeenCalledTimes(3)
    expect(runAgent.mock.calls[2][0].toolNames).toEqual(['create_skill'])
    expect(promptText(runAgent.mock.calls[2][0])).toContain('click 640,400')
    expect(savedSkills()).toEqual([{ type: 'skill_saved', skillId: 'sk-retry', name: 'Retry' }])
  })

  it('fails the run when the retry also does not save a skill', async () => {
    noteTeachStep('run-1', { at: 1, kind: 'click', x: 640, y: 400 })
    scriptTakeover([true, false])
    runAgent.mockImplementation(async (opts: { ctx: { emit: (e: unknown) => void } }) => {
      opts.ctx.emit({ type: 'final', content: 'No skill', metadata: {} })
      return { content: 'No skill', steps: [], toolsUsed: [] }
    })

    const outcome = await executeBotTask(claim as any, { leaseMs: 60_000, teachPollMs: 0 })

    expect(outcome).toBe('dead_letter')
    expect(runAgent).toHaveBeenCalledTimes(3)
    expect(runAgent.mock.calls[0][0].toolNames).not.toContain('create_skill')
    expect(runAgent.mock.calls[2][0].toolNames).toEqual(['create_skill'])
    expect(savedSkills()).toEqual([])
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({
      type: 'error',
      message: expect.stringMatching(/skill was not saved/i),
    }))
    expect(failRun).toHaveBeenCalledWith(expect.stringMatching(/skill was not saved/i))
    expect(failAgentTask).toHaveBeenCalledWith(claim, 'BOT_TEACH_SKILL_NOT_SAVED', 'The skill was not saved')
    expect(completeAgentTask).not.toHaveBeenCalled()
    expect(completeRun).not.toHaveBeenCalled()
  })
})
