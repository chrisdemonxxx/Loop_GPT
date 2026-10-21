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
import { availableTools, toolRegistry } from '../agent'
import { authorizeRunContext } from '../agent/runAuthorization'
import { ensurePersonalWorkspace } from './workspaces'
import { saveMessage } from './chatStore'
import { estimateTokens } from './billing'
import { DailyCreditError, captureDailyReservation, cleanupDailyReservation, dailyDispatch, reserveDailyCredits } from './dailyReservations'
import { sanitizeMetadata } from '../agent/guardrails'
import { startRun, setRunComputer, isRunTakeoverRequested } from './botRuns'
import { clearTeachSteps, formatTeachStepLog, loadTeachSteps } from './teachSteps'
import { ComputerSession } from './computerSession'
import { E2BDesktopError, attachDesktop } from './e2bDesktop'
import { attachUserBoxFromDB, createBoxTaskFolder, extendUserBoxLease } from './botBox'
import { COMPUTER_TOOL_NAMES, computerToolsForScreen } from '../agent/tools/computerTools'
import { builtinToolNames } from '../agent'
import { saveArtifact } from '../agent/artifacts'
import { loadSkillsForUser } from '../agent/skills/skillLoader'
import {
  AgentTaskError,
  BOT_DEFAULT_TOOLS,
  remainingVmMinutes,
  completeAgentTask,
  failAgentTask,
  isCancelRequested,
  renewAgentTaskLease,
  type AgentTaskClaim,
  type AgentTaskOutcome,
} from './agentTasks'
import type { AgentEvent, ArtifactRef, ChatMessage, ToolContext, ToolDefinition } from '../agent/types'
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
 *  Screen size comes from the live session (xdpyinfo) — never hardcode 1024×768
 *  when the box is 1366×768. Written from a live grounding probe: keyboard-first. */
export function buildComputerSystemAddendum(screen: { width: number; height: number }): string {
  return [
    `You are driving a dedicated cloud desktop (${screen.width}x${screen.height} pixels) through computer_* tools.`,
    'Loop discipline: computer_screenshot → ONE small action → read the fresh screenshot. Never chain blind actions.',
    'Prefer the keyboard over the mouse: typing and shortcuts (ctrl+l for the browser address bar, tab, enter) are far more reliable than pixel clicks.',
    'When you must click, aim for the CENTER of a large target, then read the new screenshot — if you missed, say so and click again with adjusted coordinates.',
    'Launch apps with computer_launch, then computer_wait and look before interacting.',
    'Before each action, state in one short line what you see and what you are about to do.',
  ].join('\n')
}

/** Teach-mode phase 1: announce readiness and stop. The runner handles the
 *  wait + recording; phase 2 gets the distilled demo. */
const TEACH_READY_PROMPT = [
  'You are in TEACH MODE on a dedicated cloud desktop.',
  'Say in one short sentence: "Ready — take over the live computer and demonstrate the task; press Release when done." Then STOP — do not take any actions, call no tools, end your turn immediately.',
].join('\n')

/** Teach-mode phase 2: distill the demonstration into a reusable Skill. */
function teachDistillPrompt(frameCount: number, stepLog: string): string {
  return [
    'You are in TEACH MODE. The operator just demonstrated a task on the dedicated cloud desktop; the attached frames are the recorded screen timeline (in order, with timestamps).',
    `Write a reusable Skill that automates this task end-to-end: call create_skill with a clear name, a one-line description, trigger keywords a user might say, and complete step-by-step instructions derived from the demo (exact sites, exact text to type, keyboard-first shortcuts, what "done" looks like). ${frameCount} frames were recorded.`,
    'Operator input, in order (framebuffer pixels):',
    stepLog,
    'Then reply with: the skill name, its trigger keywords, and a 2-3 sentence summary of the procedure you distilled. Do not ask questions; make reasonable assumptions and state them.',
  ].join('\n')
}

/** Load an attached skill and fold it into the run: instructions into the
 *  system prompt, its tools into the allowlist (validated against builtins). */
function attachSkill(task: { userId: string | null; skillId: string | null }, names: string[], systemPrompt: string): { names: string[]; systemPrompt: string } | null {
  if (!task.userId || !task.skillId) return null
  const skill = loadSkillsForUser(task.userId).find((s) => s.id === task.skillId)
  if (!skill) return null
  const builtins = new Set(builtinToolNames())
  const merged = [...new Set([...names, ...(skill.tools || []).filter((t) => builtins.has(t))])]
  const prompt = `${systemPrompt}\n\nATTACHED SKILL — follow this operating procedure exactly:\n---\n${skill.name}: ${skill.description}\n${skill.instructions}\n---`
  return { names: merged, systemPrompt: prompt }
}

/** The named bot's identity + remembered notes, injected for its runs so a
 *  bot answers as itself and keeps what it learned between sessions. */
export async function attachBotIdentity(
  task: { userId: string | null; botId: string | null },
  names: string[],
  systemPrompt: string,
): Promise<{ names: string[]; systemPrompt: string }> {
  if (!task.userId || !task.botId) return { names, systemPrompt }
  let persona = ''
  try {
    const { prisma } = await import('./prisma')
    const bot = prisma
      ? await prisma.bot.findFirst({ where: { id: task.botId, ownerId: task.userId }, select: { name: true, persona: true } })
      : null
    if (bot) persona = `You are "${bot.name}"${bot.persona ? ` — ${bot.persona}` : ''}. Answer as this teammate, in its voice.`
  } catch { /* persona is a nice-to-have, never a run blocker */ }
  const { botMemoryPromptSection } = await import('./botMemory')
  const memory = botMemoryPromptSection(task.userId, task.botId)
  const parts = [persona, memory].filter(Boolean)
  if (!parts.length) return { names, systemPrompt }
  const merged = names.includes('remember_fact') ? names : [...names, 'remember_fact']
  return {
    names: merged,
    systemPrompt: `${systemPrompt}\n\nBOT IDENTITY\n${parts.join('\n\n')}`,
  }
}

/** Build the authorized tool grant from the FINAL name list (after identity /
 *  skill attachment). Remember_fact and skill tools must be in the grant or
 *  the runtime returns 403 when the model calls them. */
export function buildGrantedTools(
  runNames: string[],
  catalog: ToolDefinition[],
): ToolDefinition[] {
  const byName = new Map(catalog.map((tool) => [tool.name, tool]))
  const granted: ToolDefinition[] = []
  for (const name of runNames) {
    const tool = byName.get(name)
    if (tool && !granted.some((g) => g.name === tool.name)) granted.push(tool)
  }
  return granted
}

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

/**
 * Run identity for a claimed task (B3). User-owned tasks run AS that user:
 * their personal workspace, their memory, their standing "Loop Bot"
 * conversation (the in-product result feed). System tasks (no owner) keep the
 * service account's "Ops Bot" conversation.
 */
export async function ensureRunIdentity(task: { userId: string | null }): Promise<BotIdentity> {
  if (!task.userId) return ensureBotIdentity()
  if (!hasDb || !prisma) throw new AgentTaskError('unavailable')
  const user = await prisma.user.findUnique({ where: { id: task.userId } })
  if (!user) throw new AgentTaskError('invalid_request')
  const workspace = await ensurePersonalWorkspace(user.id)
  let conversation = await prisma.conversation.findFirst({
    where: { userId: user.id, workspaceId: workspace.id, title: 'Loop Bot' },
  })
  if (!conversation) {
    conversation = await prisma.conversation.create({
      data: { userId: user.id, workspaceId: workspace.id, title: 'Loop Bot' },
    })
  }
  return { userId: user.id, workspaceId: workspace.id, conversationId: conversation.id }
}

class BotAbort extends Error {
  constructor(public readonly reason: 'cancelled' | 'lease_lost' | 'worker_stop' | 'computer_ttl') { super(reason) }
}

/** task.computer JSON → a bounded session config (disabled by default). */
function computerConfig(raw: unknown): { enabled: boolean; ttlMinutes: number } {
  const cfg = raw && typeof raw === 'object' ? raw as { enabled?: unknown; ttlMinutes?: unknown } : {}
  const ttl = Number(cfg.ttlMinutes)
  // Honor a budget clamp below the 5-minute product minimum. Missing or
  // absurd values still default to 30 — a stored 1–4 minute clamp must not
  // inflate back to 30 and bypass the daily cap.
  return {
    enabled: cfg.enabled === true,
    ttlMinutes: Number.isSafeInteger(ttl) && ttl >= 1 && ttl <= 240 ? ttl : 30,
  }
}

/**
 * Run one claimed task to completion. Returns the queue outcome; the task row
 * is always released (success ack, retry/dead-letter, or lease_lost).
 */
export async function executeBotTask(
  claim: AgentTaskClaim,
  options: { leaseMs: number; /** Screenshot poll while a teach takeover is recorded. Default 1500. */ teachPollMs?: number },
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

  // Heartbeat: renew the lease, extend the box timeout, and poll the operator
  // cancel flag. Unref'd so a wedged tick never keeps the worker alive past SIGTERM.
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
        if (task.userId) await extendUserBoxLease(task.userId).catch(() => undefined)
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
  let reservationId: string | undefined
  const runModel = task.model || process.env.BOT_MODEL || ''
  try {
    const identity = await ensureRunIdentity(task)

    // B4: user-owned runs bill the owner. Reserve before ANY provisioning
    // (model or VM); the first model dispatch marks it; capture on success,
    // release/unknown on failure. System tasks (no owner) are platform-funded.
    if (task.userId) {
      const reservation = await reserveDailyCredits(task.userId, 'bot', runModel)
      reservationId = reservation.id
    }
    const builtins = availableTools()
    const builtinNames = new Set(builtins.map((tool) => tool.name))
    const requested = Array.isArray(task.allowedTools) ? (task.allowedTools as string[]) : [...BOT_DEFAULT_TOOLS]
    const names = requested.filter((name) => builtinNames.has(name))
    if (!names.length) throw new AgentTaskError('invalid_request')

    const isTeach = task.kind === 'teach'
    // skill_saved is emitted only from the distill turn, after takeover release.
    let teachDistilling = false
    let skillSaved = false
    const emit = (event: AgentEvent) => {
      if (event.type === 'final') {
        finalContent = event.content
        finalMetadata = event.metadata || {}
      } else if (event.type === 'artifact') {
        artifacts.push(event.artifact)
      }
      run.emit(event)
      // Explicit skill_saved so the teach UI can stop waiting on a timer.
      if (teachDistilling && event.type === 'tool_result' && event.name === 'create_skill' && !event.isError) {
        const skill = event.data && typeof event.data === 'object' ? (event.data as { skill?: { id?: string; name?: string } }).skill : undefined
        if (skill?.id) {
          skillSaved = true
          run.emit({ type: 'skill_saved', skillId: String(skill.id), ...(skill.name ? { name: String(skill.name) } : {}) })
        }
      }
    }

    // Dedicated computer session (task.computer.enabled): provision the VM,
    // publish the admin live view, arm the TTL, and grant the computer_* tools.
    const computerCfg = computerConfig(task.computer)
    if (computerCfg.enabled && task.userId) {
      // Re-check at start. The TTL stored at enqueue is stale once an earlier
      // run has consumed the day's minutes, and in-flight minutes are not on
      // the row until the previous run finishes.
      computerCfg.ttlMinutes = Math.min(computerCfg.ttlMinutes, await remainingVmMinutes(task.userId))
    }
    if (computerCfg.enabled) {
      // Grok parity: the task's computer session runs INSIDE the caller's
      // persistent box when one is alive — same always-on computer, per-task
      // folder under /workspace — and only cold-boots a dedicated VM when the
      // box is down (or E2B limits force isolation).
      let existingDesktop: import('./e2bDesktop').DesktopClient | undefined
      try {
        const sandboxId = await attachUserBoxFromDB(identity.userId)
        if (sandboxId) {
          const boxRow = prisma
            ? await prisma.botBox.findUnique({ where: { userId: identity.userId }, select: { streamAuthKey: true } }).catch(() => null)
            : null
          existingDesktop = await attachDesktop(sandboxId, { streamAuthKey: boxRow?.streamAuthKey })
        }
      } catch {
        existingDesktop = undefined // fall back to a fresh dedicated VM
      }
      computer = await ComputerSession.start({
        runId: run.runId,
        userId: identity.userId,
        conversationId: identity.conversationId,
        ttlMinutes: computerCfg.ttlMinutes,
        takeoverTimeoutMs: Number(process.env.BOT_TAKEOVER_TIMEOUT_MS || 30 * 60_000),
        emit,
        isTakeoverRequested: isRunTakeoverRequested,
        ...(existingDesktop ? { existingDesktop } : {}),
        // Tag dedicated VMs so the reaper can find orphans.
        ...(!existingDesktop ? {
          createDesktopFn: (opts: { timeoutMs: number }) =>
            import('./e2bDesktop').then((m) => m.createDesktop({
              ...opts,
              metadata: { userId: identity.userId, runId: run.runId },
            })),
        } : {}),
      })
      // Per-task folder inside the box workspace (Grok's /workspace/task-*).
      void createBoxTaskFolder(identity.userId, task.id, task.goal).catch(() => {})
      await setRunComputer(run.runId, {
        sandboxId: computer.info.sandboxId,
        streamAuthKey: computer.info.streamAuthKey,
        viewUrl: computer.info.viewUrl,
        interactiveUrl: computer.info.interactiveUrl,
        startedAt: new Date().toISOString(),
      })
      emit({ type: 'status', message: `Dedicated computer ready (${computer.info.sandboxId}); live view available to admins` })
      // Teach takeover waits are not ended by the run TTL — arm after recording.
      if (!isTeach) {
        ttlTimer = setTimeout(() => abort.abort(new BotAbort('computer_ttl')), computerCfg.ttlMinutes * 60_000)
        ttlTimer.unref?.()
      }
    }

    const ctx: ToolContext = {
      userId: identity.userId,
      conversationId: identity.conversationId,
      emit,
      signal: abort.signal,
      scratch: {
        ...(computer ? { computer } : {}),
        ...(task.botId ? { botId: task.botId } : {}),
      },
    }
    // create_skill stays in the run grant so the distill turn can narrow to it.
    // The readiness turn passes names without it (see phase 1 below).
    const skillTool = isTeach ? toolRegistry.get('create_skill') : undefined
    let runNames = computer ? [...names, ...COMPUTER_TOOL_NAMES] : [...names]
    const screen = computer?.screen || { width: 1366, height: 768 }
    let systemPrompt = computer
      ? `${BOT_SYSTEM_PROMPT}\n\n${buildComputerSystemAddendum(screen)}`
      : BOT_SYSTEM_PROMPT
    const attached = attachSkill(task, runNames, systemPrompt)
    if (attached) { runNames = attached.names; systemPrompt = attached.systemPrompt }
    const identified = await attachBotIdentity(task, runNames, systemPrompt)
    runNames = identified.names
    systemPrompt = identified.systemPrompt
    if (skillTool && !runNames.includes('create_skill')) runNames = [...runNames, 'create_skill']
    // Grant AFTER identity/skill attachment so remember_fact (and skill tools)
    // are actually authorized — building earlier left them as names-only → 403.
    // Tool descriptions use the live xdpyinfo size so clicks match the canvas.
    const computerTools = computer ? computerToolsForScreen(screen) : []
    const catalog: ToolDefinition[] = [
      ...builtins,
      ...computerTools,
      ...(skillTool ? [skillTool] : []),
    ]
    const grantedTools = buildGrantedTools(runNames, catalog)
    const authorizedCtx = await authorizeRunContext(ctx, identity.workspaceId, grantedTools)
    run.emit({ type: 'run', runId: run.runId } as AgentEvent)
    run.emit({ type: 'status', message: `task:${task.id}` } as AgentEvent)

    const runAgentOnce = async (messages: ChatMessage[], prompt: string, names: string[]) => runAgent({
      messages,
      provider: 'huggingface',
      model: runModel,
      toolNames: names,
      systemPrompt: prompt,
      maxSteps: task.maxSteps ?? undefined,
      thinking: (task.thinking || undefined) as ThinkingInput,
      autoApprove: true, // allowlisted tools only; no interactive gate exists off-HTTP
      useMemory: true,
      ctx: authorizedCtx,
      // The first real model dispatch flips the reservation to dispatched.
      beforeDispatch: reservationId ? dailyDispatch(reservationId, abort.signal) : undefined,
    })

    let messages: ChatMessage[] = [{ role: 'user', content: task.goal }]
    if (isTeach && computer) {
      // Phase 1: announce readiness. create_skill is not granted on this turn.
      const readinessNames = runNames.filter((name) => name !== 'create_skill')
      await runAgentOnce([{ role: 'user', content: 'Announce teach readiness now.' }], `${BOT_SYSTEM_PROMPT}\n\n${TEACH_READY_PROMPT}`, readinessNames)
      if (abort.signal.aborted) throw abort.signal.reason instanceof BotAbort ? abort.signal.reason : new BotAbort('worker_stop')
      emit({ type: 'status', message: 'Waiting for the operator to take over and demonstrate… (the session records what you do)' })
      // Phase 1.5: record the takeover demonstration. Frames every ~1.5s while
      // the operator drives; the step list (clicks/keys/types) sits beside them.
      // Stop on Release or a time cap (no hard frame count).
      // The run TTL does not end this wait — it is armed after recording.
      const recording: Array<{ at: number; png: Buffer }> = []
      const teachWindowMs = Number(process.env.BOT_TEACH_MAX_MS || process.env.BOT_TAKEOVER_TIMEOUT_MS || 30 * 60_000)
      const teachPollMs = Number.isFinite(options.teachPollMs) ? Math.max(0, options.teachPollMs as number) : 1500
      const takeoverDeadline = Date.now() + teachWindowMs
      let sawTakeover = false
      let steps = await loadTeachSteps(run.runId)
      while (Date.now() < takeoverDeadline && !abort.signal.aborted) {
        const takeover = await isRunTakeoverRequested(run.runId).catch(() => false)
        if (takeover) {
          sawTakeover = true
          try { recording.push({ at: Date.now(), png: await computer.captureSilent() }) } catch { /* transient */ }
          steps = await loadTeachSteps(run.runId)
          emit({ type: 'status', message: `Recording the demonstration… ${recording.length} frame(s), ${steps.length} step(s)` })
        } else if (sawTakeover) {
          break // released: the demo is done
        }
        await new Promise((r) => setTimeout(r, teachPollMs))
      }
      steps = await loadTeachSteps(run.runId)
      if (abort.signal.aborted) {
        throw abort.signal.reason instanceof BotAbort ? abort.signal.reason : new BotAbort('worker_stop')
      }
      // Arm the computer TTL for the distill phase now that recording is done.
      if (!ttlTimer) {
        ttlTimer = setTimeout(() => abort.abort(new BotAbort('computer_ttl')), computerCfg.ttlMinutes * 60_000)
        ttlTimer.unref?.()
      }
      if (!sawTakeover) {
        if (reservationId) await cleanupDailyReservation(reservationId)
        await run.fail('Teach session ended without a demonstration — no takeover happened during the wait window', true)
        return failAgentTask(claim, 'BOT_TEACH_NO_DEMO', 'Operator never took over')
      }
      // Stop can land between polls. Count the release frame before deciding
      // the demo is empty, so a click-then-Stop still has a screenshot.
      try { recording.push({ at: Date.now(), png: await computer.captureSilent() }) } catch { /* transient */ }
      steps = await loadTeachSteps(run.runId)
      // One screenshot and one stored step is a demo. No takeover and zero
      // steps never reach create_skill.
      if (recording.length < 1 || steps.length < 1) {
        if (reservationId) await cleanupDailyReservation(reservationId)
        await run.fail('Nothing was recorded. Take over, show the task on screen, and perform at least one click, key, or typed step before you release.')
        return failAgentTask(claim, 'BOT_TEACH_NOTHING_RECORDED', 'Nothing was recorded')
      }
      // Persist a few key frames as artifacts so the operator sees the demo.
      const stride = Math.max(1, Math.floor(recording.length / 6))
      for (let i = 0; i < recording.length; i += stride) {
        const png = recording[i].png
        const artifact = await saveArtifact(`teach-frame-${String(i + 1).padStart(2, '0')}.png`, png,
          { userId: identity.userId, conversationId: identity.conversationId })
        artifacts.push(artifact)
        emit({ type: 'artifact', artifact })
      }
      // Phase 2: distill frames plus the ordered step log into a Skill.
      // The model sees up to 10 frames (newest-biased spread) as real image parts.
      const picked: number[] = []
      if (recording.length <= 10) picked.push(...recording.map((_, i) => i))
      else {
        const step = recording.length / 10
        for (let i = 0; i < 10; i++) picked.push(Math.min(recording.length - 1, Math.floor(i * step)))
      }
      const timelineText = picked.map((i) => `frame ${i + 1}/${recording.length} at +${Math.round((recording[i].at - recording[0].at) / 1000)}s`).join(', ')
      const stepLog = formatTeachStepLog(steps)
      const teachMessage: ChatMessage = {
        role: 'user',
        content: [
          { type: 'text', text: `${task.goal}\n\n${teachDistillPrompt(recording.length, stepLog)}\n\nTimeline: ${timelineText}.` },
          ...picked.map((i) => ({ type: 'image_url' as const, image_url: { url: `data:image/png;base64,${recording[i].png.toString('base64')}` } })),
        ],
      }
      messages = [teachMessage]
      teachDistilling = true
      try {
        await runAgentOnce(messages, systemPrompt, runNames)
        // The distill turn can describe the demo and never call the tool.
        // One more turn, granted only create_skill, uses the same log and frames.
        if (!skillSaved) {
          const retryPrompt = [
            systemPrompt,
            'The previous turn did not save a skill. Call create_skill now — it is the only tool available.',
            'Use the operator step log and the recorded frames in the conversation. Do not ask questions.',
          ].join('\n\n')
          await runAgentOnce(messages, retryPrompt, ['create_skill'])
        }
      } finally {
        teachDistilling = false
      }
      if (!skillSaved) {
        const message = 'The skill was not saved. The demonstration was recorded, but create_skill did not store a skill.'
        emit({ type: 'error', message })
        if (reservationId) await cleanupDailyReservation(reservationId)
        await run.fail(message)
        return failAgentTask(claim, 'BOT_TEACH_SKILL_NOT_SAVED', 'The skill was not saved')
      }
    } else {
      await runAgentOnce(messages, systemPrompt, runNames)
    }
    if (abort.signal.aborted) throw abort.signal.reason instanceof BotAbort ? abort.signal.reason : new BotAbort('worker_stop')

    const usage = { tokensIn: estimateTokens(task.goal), tokensOut: estimateTokens(finalContent), model: runModel || undefined }
    // B4: settle the owner's reservation with the real token evidence. The
    // settlement worker replays a persisted intent if this capture races a
    // crash, so a throw here never loses the charge.
    if (reservationId && task.userId) {
      await captureDailyReservation(reservationId, task.userId, 'bot', {
        tokensIn: usage.tokensIn, tokensOut: usage.tokensOut, model: runModel,
      }).catch((error) => console.error('Bot reservation capture needs reconciliation:', reservationId, error))
    }
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
    // The task wrote files into the box; flush the workspace to the durable
    // mirror now so a box death before the next idle sync costs nothing.
    if (computer && task.userId) {
      const { syncUserBoxNow } = await import('./botBox')
      await syncUserBoxNow(task.userId).catch(() => undefined)
    }
    const ack = await completeAgentTask(claim)
    if (ack === 'cancelled') return 'cancelled'
    return ack === 'succeeded' ? 'succeeded' : 'lease_lost'
  } catch (error: any) {
    // B4: every failure path settles the reservation exactly once — release if
    // never dispatched, unknown if it was (no post-dispatch refund, per the
    // accounting doctrine).
    if (reservationId) await cleanupDailyReservation(reservationId)
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
    if (error instanceof AgentTaskError && error.code === 'quota') {
      await run.fail("Today's dedicated-computer budget is used up")
      return failAgentTask(claim, 'BOT_COMPUTER_QUOTA', error.message)
    }
    const code = error instanceof AgentTaskError ? 'BOT_TASK_INVALID'
      : error instanceof E2BDesktopError && error.code === 'auth' ? 'BOT_COMPUTER_UNCONFIGURED'
      : error instanceof E2BDesktopError ? 'BOT_COMPUTER_UNAVAILABLE'
      : error instanceof DailyCreditError ? 'BOT_OUT_OF_CREDITS'
      : 'BOT_RUN_FAILED'
    await run.fail((error?.message || code).slice(0, 300))
    return failAgentTask(claim, code, error?.message)
  } finally {
    clearInterval(heartbeat)
    workerSignal?.removeEventListener('abort', stopFromWorker)
    if (ttlTimer) clearTimeout(ttlTimer)
    clearTeachSteps(run.runId)
    if (computer) {
      // Meter VM-minutes onto the run record before tearing the desktop down.
      await setRunComputer(run.runId, { minutes: computer.minutes(), endedAt: new Date().toISOString() })
      await computer.close()
    }
  }
}
