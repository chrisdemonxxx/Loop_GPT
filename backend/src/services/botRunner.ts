/**
 * Executes one claimed agent task against the agent runtime, in-process, with
 * no HTTP request in sight. This is the "bot computer" brain: the same
 * runAgent + tool grant pipeline the interactive stream uses, driven by the
 * queue instead of a user turn.
 *
 * Ownership: the caller holds a DB lease (agentTasks). Long agent runs renew
 * that lease on a heartbeat; a failed renewal or an operator cancel flag
 * aborts the run instead of racing another worker.
 */
import { randomUUID } from 'crypto'
import bcrypt from 'bcryptjs'
import { prisma, hasDb } from './prisma'
import { runAgent } from '../agent/agentRuntime'
import { availableTools } from '../agent'
import { authorizeRunContext } from '../agent/runAuthorization'
import { ensurePersonalWorkspace } from './workspaces'
import { saveMessage } from './chatStore'
import { estimateTokens } from './billing'
import { sanitizeMetadata } from '../agent/guardrails'
import { startRun, setRunComputer, isRunTakeoverRequested } from './botRuns'
import { ComputerSession } from './computerSession'
import { E2BDesktopError } from './e2bDesktop'
import { COMPUTER_TOOLS, COMPUTER_TOOL_NAMES } from '../agent/tools/computerTools'
import {
  AgentTaskError,
  BOT_DEFAULT_TOOLS,
  completeAgentTask,
  failAgentTask,
  isCancelRequested,
  renewAgentTaskLease,
  type AgentTaskClaim,
  type AgentTaskOutcome,
} from './agentTasks'
import type { AgentEvent, ArtifactRef, ChatMessage, ToolContext } from '../agent/types'
import type { ThinkingInput } from '../agent/thinking'

const BOT_SYSTEM_PROMPT = [
  'You are Loop GPT\'s autonomous operations bot, working in the background with no human watching.',
  'Work the assigned goal end-to-end and deliver a complete result in a single run:',
  '- Never ask questions or wait for input. Make reasonable assumptions and state them.',
  '- Use the available tools proactively: search and read the web, run code, produce documents.',
  '- Save deliverables with create_document. Durable facts go into the remember tool.',
  '- Finish with a concise final report: what you did, key findings, and where the artifacts are.',
].join('\n')

/** Computer-use discipline, appended only when a dedicated desktop is attached.
 *  Written from a live grounding probe (2026-10-05): the model reads screens
 *  well but its raw coordinate picks drift, so the loop is keyboard-first and
 *  always re-observes. */
const COMPUTER_SYSTEM_ADDENDUM = [
  'You are driving a dedicated cloud desktop (1024x768 pixels) through computer_* tools.',
  'Loop discipline: computer_screenshot → ONE small action → read the fresh screenshot. Never chain blind actions.',
  'Prefer the keyboard over the mouse: typing and shortcuts (ctrl+l for the browser address bar, tab, enter) are far more reliable than pixel clicks.',
  'When you must click, aim for the CENTER of a large target, then read the new screenshot — if you missed, say so and click again with adjusted coordinates.',
  'Launch apps with computer_launch, then computer_wait and look before interacting.',
  'Before each action, state in one short line what you see and what you are about to do.',
].join('\n')

export interface BotIdentity { userId: string; workspaceId: string; conversationId: string }

let identityPromise: Promise<BotIdentity> | undefined

/** Find-or-create the service account, its personal workspace and the standing
 *  "Ops Bot" conversation results are posted into. Idempotent; cached in-process. */
export function ensureBotIdentity(): Promise<BotIdentity> {
  identityPromise ??= (async () => {
    if (!hasDb || !prisma) throw new AgentTaskError('unavailable')
    const email = (process.env.BOT_USER_EMAIL || 'ops-bot@loop-gpt.cyou').toLowerCase()
    let user = await prisma.user.findUnique({ where: { email } })
    if (!user) {
      // Unusable random credential: the bot never logs in; the row exists so the
      // run grant, memories, private files and conversation ownership all have
      // a real identity to hang off.
      const password = await bcrypt.hash(randomUUID() + randomUUID(), 10)
      user = await prisma.user.create({ data: { email, password, name: 'Ops Bot', emailVerified: true } })
    }
    const workspace = await ensurePersonalWorkspace(user.id)
    let conversation = await prisma.conversation.findFirst({
      where: { userId: user.id, workspaceId: workspace.id, title: 'Ops Bot' },
    })
    if (!conversation) {
      conversation = await prisma.conversation.create({
        data: { userId: user.id, workspaceId: workspace.id, title: 'Ops Bot' },
      })
    }
    return { userId: user.id, workspaceId: workspace.id, conversationId: conversation.id }
  })()
  return identityPromise
}

/** Test hook: drop the cached identity. */
export function resetBotIdentityCache() { identityPromise = undefined }

class BotAbort extends Error {
  constructor(public readonly reason: 'cancelled' | 'lease_lost' | 'worker_stop' | 'computer_ttl') { super(reason) }
}

/** task.computer JSON → a bounded session config (disabled by default). */
function computerConfig(raw: unknown): { enabled: boolean; ttlMinutes: number } {
  const cfg = raw && typeof raw === 'object' ? raw as { enabled?: unknown; ttlMinutes?: unknown } : {}
  const ttl = Number(cfg.ttlMinutes)
  return {
    enabled: cfg.enabled === true,
    ttlMinutes: Number.isSafeInteger(ttl) && ttl >= 5 && ttl <= 240 ? ttl : 30,
  }
}

/**
 * Run one claimed task to completion. Returns the queue outcome; the task row
 * is always released (success ack, retry/dead-letter, or lease_lost).
 */
export async function executeBotTask(
  claim: AgentTaskClaim,
  options: { leaseMs: number },
  workerSignal?: AbortSignal,
): Promise<AgentTaskOutcome> {
  if (!hasDb || !prisma) return 'lease_lost'
  const task = await prisma.agentTask.findUnique({ where: { id: claim.taskId } })
  // Missing row: nothing to ack (cascade delete wins). Unexpected status: the
  // row was re-claimed or retired elsewhere — our token guard will fail anyway.
  if (!task || task.status !== 'processing') return 'lease_lost'
  if (task.cancelRequested) {
    return failAgentTask(claim, 'BOT_TASK_CANCELLED', 'Cancelled by operator')
  }

  const run = await startRun(task.id)
  const abort = new AbortController()
  const stopFromWorker = () => abort.abort(new BotAbort('worker_stop'))
  workerSignal?.addEventListener('abort', stopFromWorker, { once: true })

  // Heartbeat: renew the lease and poll the operator cancel flag. Unref'd so a
  // wedged tick never keeps the worker alive past SIGTERM.
  let leaseLost = false
  const heartbeatMs = Math.max(5000, Math.floor(options.leaseMs / 3))
  const heartbeat = setInterval(() => {
    void (async () => {
      try {
        if (!await renewAgentTaskLease(claim, options.leaseMs)) {
          leaseLost = true
          abort.abort(new BotAbort('lease_lost'))
          return
        }
        if (await isCancelRequested(task.id)) abort.abort(new BotAbort('cancelled'))
      } catch { /* transient DB errors ride the next tick */ }
    })()
  }, heartbeatMs)
  heartbeat.unref()

  let finalContent = ''
  let finalMetadata: any = {}
  const artifacts: ArtifactRef[] = []
  let computer: ComputerSession | undefined
  let ttlTimer: ReturnType<typeof setTimeout> | undefined
  try {
    const identity = await ensureBotIdentity()
    const builtins = availableTools()
    const builtinNames = new Set(builtins.map((tool) => tool.name))
    const requested = Array.isArray(task.allowedTools) ? (task.allowedTools as string[]) : [...BOT_DEFAULT_TOOLS]
    const names = requested.filter((name) => builtinNames.has(name))
    if (!names.length) throw new AgentTaskError('invalid_request')
    const tools = builtins.filter((tool) => names.includes(tool.name))

    const emit = (event: AgentEvent) => {
      if (event.type === 'final') {
        finalContent = event.content
        finalMetadata = event.metadata || {}
      } else if (event.type === 'artifact') {
        artifacts.push(event.artifact)
      }
      run.emit(event)
    }

    // Dedicated computer session (task.computer.enabled): provision the VM,
    // publish the admin live view, arm the TTL, and grant the computer_* tools.
    const computerCfg = computerConfig(task.computer)
    if (computerCfg.enabled) {
      computer = await ComputerSession.start({
        runId: run.runId,
        userId: identity.userId,
        conversationId: identity.conversationId,
        ttlMinutes: computerCfg.ttlMinutes,
        emit,
        isTakeoverRequested: isRunTakeoverRequested,
      })
      await setRunComputer(run.runId, {
        sandboxId: computer.info.sandboxId,
        streamAuthKey: computer.info.streamAuthKey,
        viewUrl: computer.info.viewUrl,
        interactiveUrl: computer.info.interactiveUrl,
        startedAt: new Date().toISOString(),
      })
      emit({ type: 'status', message: `Dedicated computer ready (${computer.info.sandboxId}); live view available to admins` })
      ttlTimer = setTimeout(() => abort.abort(new BotAbort('computer_ttl')), computerCfg.ttlMinutes * 60_000)
      ttlTimer.unref?.()
    }

    const ctx: ToolContext = {
      userId: identity.userId,
      conversationId: identity.conversationId,
      emit,
      signal: abort.signal,
      scratch: computer ? { computer } : {},
    }
    const grantedTools = computer ? [...tools, ...COMPUTER_TOOLS] : tools
    const authorizedCtx = await authorizeRunContext(ctx, identity.workspaceId, grantedTools)
    run.emit({ type: 'run', runId: run.runId } as AgentEvent)
    run.emit({ type: 'status', message: `task:${task.id}` } as AgentEvent)

    const messages: ChatMessage[] = [{ role: 'user', content: task.goal }]
    await runAgent({
      messages,
      provider: 'huggingface',
      model: task.model || process.env.BOT_MODEL || '',
      toolNames: computer ? [...names, ...COMPUTER_TOOL_NAMES] : names,
      systemPrompt: computer ? `${BOT_SYSTEM_PROMPT}\n\n${COMPUTER_SYSTEM_ADDENDUM}` : BOT_SYSTEM_PROMPT,
      maxSteps: task.maxSteps ?? undefined,
      thinking: (task.thinking || undefined) as ThinkingInput,
      autoApprove: true, // allowlisted tools only; no interactive gate exists off-HTTP
      useMemory: true,
      ctx: authorizedCtx,
    })
    if (abort.signal.aborted) throw abort.signal.reason instanceof BotAbort ? abort.signal.reason : new BotAbort('worker_stop')

    const usage = { tokensIn: estimateTokens(task.goal), tokensOut: estimateTokens(finalContent), model: task.model || process.env.BOT_MODEL || undefined }
    // The standing "Ops Bot" conversation is the operator-visible result feed.
    await saveMessage(identity.conversationId, {
      role: 'assistant',
      content: finalContent || '(no response)',
      messageType: artifacts.some((a) => a.kind === 'image') ? 'image' : 'text',
      toolUsed: 'bot',
      metadata: sanitizeMetadata({
        botTaskId: task.id,
        botRunId: run.runId,
        artifacts,
        usage,
        steps: Array.isArray(finalMetadata.steps) ? finalMetadata.steps.length : 0,
      }),
    })
    await run.complete({ content: finalContent, artifacts, usage })
    const ack = await completeAgentTask(claim)
    return ack === 'succeeded' ? 'succeeded' : 'lease_lost'
  } catch (error: any) {
    const reason = error instanceof BotAbort ? error.reason : undefined
    if (reason === 'lease_lost' || leaseLost) {
      await run.fail('Lease lost mid-run; another worker owns this task')
      return 'lease_lost'
    }
    if (reason === 'cancelled') {
      await run.fail('Cancelled by operator', true)
      return failAgentTask(claim, 'BOT_TASK_CANCELLED', 'Cancelled by operator')
    }
    if (reason === 'worker_stop') {
      await run.fail('Worker shutting down', true)
      // Leave the lease to expire naturally so the next worker replays it.
      return 'retry'
    }
    if (reason === 'computer_ttl') {
      await run.fail('Dedicated computer reached its session time budget')
      return failAgentTask(claim, 'BOT_COMPUTER_TTL', 'Computer session TTL reached')
    }
    const code = error instanceof AgentTaskError ? 'BOT_TASK_INVALID'
      : error instanceof E2BDesktopError ? 'BOT_COMPUTER_UNAVAILABLE'
      : 'BOT_RUN_FAILED'
    await run.fail((error?.message || code).slice(0, 300))
    return failAgentTask(claim, code, error?.message)
  } finally {
    clearInterval(heartbeat)
    workerSignal?.removeEventListener('abort', stopFromWorker)
    if (ttlTimer) clearTimeout(ttlTimer)
    if (computer) {
      // Meter VM-minutes onto the run record before tearing the desktop down.
      await setRunComputer(run.runId, { minutes: computer.minutes(), endedAt: new Date().toISOString() })
      await computer.close()
    }
  }
}
