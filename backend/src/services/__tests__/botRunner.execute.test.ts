/**
 * executeBotTask happy path with faked E2B / computer — no live provider.
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
const extendUserBoxLease = vi.fn()
const computerStart = vi.fn()
const attachDesktop = vi.fn()
const ensurePersonalWorkspace = vi.fn()

vi.mock('../prisma', () => ({
  hasDb: true,
  prisma: {
    agentTask: { findUnique: (...args: unknown[]) => findUniqueTask(...args) },
    user: { findUnique: (...args: unknown[]) => findUniqueUser(...args) },
    conversation: {
      findFirst: (...args: unknown[]) => findFirstConversation(...args),
      create: vi.fn(),
    },
    botBox: { findUnique: vi.fn(async () => null) },
  },
}))

// Agent packages live under src/agent — mock paths must resolve there (not
// services/agent), matching botRunner's `../agent/...` imports.
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
  toolRegistry: { get: () => undefined },
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
  saveArtifact: vi.fn(),
}))

vi.mock('../../agent/guardrails', () => ({
  sanitizeMetadata: (v: unknown) => v,
}))

vi.mock('../workspaces', () => ({
  ensurePersonalWorkspace: (...args: unknown[]) => ensurePersonalWorkspace(...args),
  workspaceDb: () => ({ $transaction: async (fn: any) => fn({}) }),
  WorkspaceError: class extends Error { code = 'workspace' },
  requireMembership: vi.fn(async () => ({ role: 'owner' })),
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
  extendUserBoxLease: (...args: unknown[]) => extendUserBoxLease(...args),
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

const userId = 'user-exec-1'
const claim = { taskId: 'task-1', leaseToken: 'lease-1', attempt: 1 }

function baseTask(overrides: Record<string, unknown> = {}) {
  return {
    id: 'task-1',
    status: 'processing',
    cancelRequested: false,
    userId,
    model: 'test-model',
    allowedTools: ['web_search'],
    kind: 'ops',
    computer: null,
    maxSteps: 5,
    thinking: null,
    botId: null,
    skillId: null,
    goal: 'Say hello',
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
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
  dailyDispatch.mockReturnValue(async () => undefined)
  attachUserBoxFromDB.mockResolvedValue(null)
  attachDesktop.mockRejectedValue(new Error('no live box'))
  createBoxTaskFolder.mockResolvedValue('/workspace/task-folders/task-1')
  startRun.mockResolvedValue({
    runId: 'run-1',
    emit: vi.fn(),
    complete: vi.fn(async () => undefined),
    fail: vi.fn(async () => undefined),
  })
  runAgent.mockImplementation(async (opts: { ctx: { emit: (e: unknown) => void } }) => {
    opts.ctx.emit({ type: 'final', content: 'Hello from bot', metadata: {} })
    return { content: 'Hello from bot', steps: [], toolsUsed: [] }
  })
  computerStart.mockResolvedValue({
    info: {
      sandboxId: 'sbx-fake',
      streamAuthKey: 'key',
      viewUrl: '/novnc/vnc.html?path=%2Fapi%2Fbot%2Fnovnc%2Fsbx-fake%2Fwebsockify',
      interactiveUrl: '/novnc/vnc.html?path=%2Fapi%2Fbot%2Fnovnc%2Fsbx-fake%2Fwebsockify',
    },
    minutes: () => 1,
    close: vi.fn(async () => undefined),
    captureSilent: vi.fn(async () => Buffer.from('png')),
  })
})

describe('executeBotTask happy path (fake E2B)', () => {
  it('completes a chat-only task without a computer', async () => {
    const outcome = await executeBotTask(claim as any, { leaseMs: 60_000 })
    expect(outcome).toBe('succeeded')
    expect(runAgent).toHaveBeenCalled()
    expect(completeAgentTask).toHaveBeenCalledWith(claim)
    expect(computerStart).not.toHaveBeenCalled()
    expect(saveMessage).toHaveBeenCalled()
  })

  it('provisions a dedicated computer via ComputerSession when no box is attached', async () => {
    findUniqueTask.mockResolvedValue(baseTask({
      computer: { enabled: true, ttlMinutes: 10 },
    }))
    const outcome = await executeBotTask(claim as any, { leaseMs: 60_000 })
    expect(outcome).toBe('succeeded')
    expect(computerStart).toHaveBeenCalled()
    expect(setRunComputer).toHaveBeenCalledWith('run-1', expect.objectContaining({ sandboxId: 'sbx-fake' }))
    expect(createBoxTaskFolder).toHaveBeenCalled()
    const session = await computerStart.mock.results[0].value
    expect(session.close).toHaveBeenCalled()
  })
})
