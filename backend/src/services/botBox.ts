import crypto from 'node:crypto'
import { buildVncUrls, isE2BConfigured } from './e2bDesktop'
import { awaitGnomeDesktop, desktopTemplateId, seedDesktopLaunchers } from './gnomeSession'
import { prisma } from './prisma'
import { readBotMemory } from './botMemory'
import { restoreWorkspaceIn, syncWorkspaceOut, syncWorkspaceThrottled } from './workspaceSync'

type Sandbox = any

/**
 * Persistent agent box (Grok Bot parity — its VM is always on):
 *
 *  Every user has ONE long-lived desktop sandbox ("box") that every bot task
 *  with a computer uses. The box has a home profile (display, wallpaper,
 *  autostart apps) and a /workspace that accumulates per-task folders
 *  (Grok's Thunar screenshots show exactly this: /workspace with many task
 *  folders + shell scripts, Chrome + terminal + Thunar in the taskbar).
 *
 *  Task types get their own tool packs: a coding task boots with terminal +
 *  file manager + Chrome, a research task with Chrome only, an ops task with
 *  the terminal — tools appear "pre-installed" because the box seeds them at
 *  boot (desktop icons, bookmarks, PATH helpers) per taskType.
 *
 *  Idle boxes are paused (E2B auto-pauses); first touch after idle does a
 *  fast resume (~1s), not a cold boot (~30s). A box only dies when it has
 *  been idle past BOX_IDLE_TTL_MS.
 */

/** Provider cap: this E2B tier rejects sandbox timeouts > 1h. The box stays
 *  "always on" in practice via touch-keepalive (every use extends the timer)
 *  and fast resume — when it does expire, the next touch re-boots + re-seeds. */
export const BOX_IDLE_TTL_MS = 60 * 60 * 1000
/** GNOME setup often outlives a 1–5 minute sandbox. Create and connect use at
 *  least this long, then the timeout is shrunk to the real daily remainder. */
const MIN_BOOT_TIMEOUT_MS = 10 * 60 * 1000
/** Below this, a new sandbox cannot finish booting. Refuse instead of creating. */
const BOOT_QUOTA_FLOOR_MINUTES = 5
/** Spent-budget keepalive. Never substitute the 1 hour provider cap. */
const SOFT_KEEPALIVE_MS = 60_000
/** Untracked provider VMs younger than this are still in boot. The reaper
 *  must not kill them before the BotBox row (or a failed boot's cleanup) lands. */
const UNTRACKED_BOOT_GRACE_MS = 15 * 60 * 1000
const DESKTOP_BOOT_RETRY_MESSAGE = 'The desktop did not finish starting. Try again.'
/** Documented E2B Desktop default geometry (also COMPUTER_FALLBACK_SCREEN). */
export const DEFAULT_SCREEN = { width: 1366, height: 768 }

export type BoxTaskType = 'default' | 'coding' | 'research' | 'ops' | 'teach'

export interface BoxSpec {
  sandboxId: string
  streamUrl: string
  interactiveUrl: string | null
  resumed: boolean
  ageMinutes: number
  taskType: BoxTaskType
  workspaceDir: string
}

interface BoxState {
  sandboxId: string
  sandbox: Sandbox
  createdAt: number
  lastTouchedAt: number
}

const liveBoxes = new Map<string, BoxState>()

async function runInBox(sandbox: Sandbox, cmd: string, timeoutMs = 25_000): Promise<void> {
  try {
    await sandbox.commands.run(cmd, { timeoutMs })
  } catch {
    // Non-fatal — box setup is best-effort per command.
  }
}

function quote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/** Seed the box's home profile + workspace for a task type (idempotent). */
async function seedBoxProfile(sandbox: Sandbox, userLabel: string, taskType: BoxTaskType): Promise<void> {
  const host = process.env.LOOP_BOT_BOX_HOSTNAME || `loop-bot-vm-${crypto.randomBytes(4).toString('hex')}`
  const bashrcAdd = [
    `export PS1="\\[\\e[1;32m\\]box@${host}\\[\\e[0m\\]:\\[\\e[1;34m\\]\\w\\[\\e[0m\\]\\$ "`,
    `alias ll='ls -la --color=auto'`,
    `cd /workspace 2>/dev/null || true`,
  ].join('\n')

  await runInBox(sandbox, [
    // Identity + workspace
    `sudo hostnamectl set-hostname ${quote(host)} 2>/dev/null || sudo hostname ${quote(host)} || true`,
    `mkdir -p /workspace/task-folders /workspace/teach-sessions /home/user/.config`,
    // Prompt like Grok's (box@loop-bot-vm-…:~/workspace$)
    `printf '%s\\n' ${quote(bashrcAdd)} >> /home/user/.bashrc`,
    `printf '%s\\n' ${quote(bashrcAdd)} >> /root/.bashrc`,
    // Box label on the desktop
    `printf 'Loop Bot box — %s\\nworkspace: /workspace\\n' ${quote(userLabel)} > /home/user/Desktop/ABOUT_THIS_BOX.txt 2>/dev/null || true`,
  ].join(' && '))

  // Chrome + terminal desktop icons on every cold boot (Grok-feel first paint).
  await seedDesktopLaunchers(sandbox)

  // Task-type tool packs — what appears ready-made on the desktop.
  const packs: Record<BoxTaskType, string[]> = {
    default: [],
    coding: [
      `mkdir -p /workspace/task-folders`,
      // terminal + editor + chrome, autostarted
      `mkdir -p /home/user/.config/autostart && printf '[Desktop Entry]\\nType=Application\\nName=Terminal\\nExec=x-terminal-emulator --working-directory=/workspace\\nX-GNOME-Autostart-enabled=true\\n' > /home/user/.config/autostart/terminal.desktop`,
    ],
    research: [
      `mkdir -p /home/user/.config/autostart && printf '[Desktop Entry]\\nType=Application\\nName=Chrome\\nExec=google-chrome --start-maximized https://www.google.com\\nX-GNOME-Autostart-enabled=true\\n' > /home/user/.config/autostart/chrome.desktop`,
    ],
    ops: [
      `mkdir -p /home/user/.config/autostart && printf '[Desktop Entry]\\nType=Application\\nName=Terminal\\nExec=x-terminal-emulator --working-directory=/workspace\\nX-GNOME-Autostart-enabled=true\\n' > /home/user/.config/autostart/terminal.desktop`,
      `mkdir -p /home/user/.config/autostart && printf '[Desktop Entry]\\nType=Application\\nName=Files\\nExec=nautilus /workspace\\nX-GNOME-Autostart-enabled=true\\n' > /home/user/.config/autostart/files.desktop`,
    ],
    teach: [
      `mkdir -p /workspace/teach-sessions`,
      `mkdir -p /home/user/.config/autostart && printf '[Desktop Entry]\\nType=Application\\nName=Terminal\\nExec=x-terminal-emulator --working-directory=/workspace\\nX-GNOME-Autostart-enabled=true\\n' > /home/user/.config/autostart/terminal.desktop`,
    ],
  }
  const cmds = packs[taskType] || packs.default
  if (cmds.length > 0) await runInBox(sandbox, cmds.join(' && '))
}

/** Every bot gets a home inside the one computer, and every bot sees the
 *  shared dir — "multiple agents deployed inside it, files stay with them".
 *  Idempotent: homes are created only when absent, and a bot's MEMORY.md is
 *  seeded from the durable mirror without overwriting notes it wrote itself. */
async function seedBotHomes(sandbox: Sandbox, userId: string): Promise<void> {
  if (!prisma) return
  try {
    const bots = await prisma.bot.findMany({ where: { ownerId: userId }, select: { id: true, name: true } })
    await runInBox(sandbox, `mkdir -p /workspace/agents /workspace/shared`)
    for (const bot of bots) {
      const home = `/workspace/agents/${bot.id}`
      const mirror = readBotMemory(userId, bot.id)
      await runInBox(sandbox, [
        `mkdir -p ${quote(home)}`,
        `[ -f ${quote(`${home}/README.md`)} ] || printf '# %s\\nHome of bot %s. Files here persist; /workspace/shared is visible to every bot.\\n' ${quote(bot.name)} ${quote(bot.id)} > ${quote(`${home}/README.md`)}`,
        ...(mirror ? [`printf '%s\\n' ${quote(mirror)} > ${quote(`${home}/MEMORY.md`)}`] : []),
      ].join(' && '))
    }
  } catch { /* home seeding is best-effort, never a boot blocker */ }
}

async function readVncUrls(sandbox: Sandbox): Promise<{ streamUrl: string; interactiveUrl: string | null; streamAuthKey: string | null }> {
  // The @e2b/desktop sandbox exposes a managed noVNC stream.
  try {
    await sandbox.stream.start({ requireAuth: true })
  } catch (error) {
    // Stream already up (box resume / second attach) — keep going and read
    // the auth key from this SDK instance's state.
    if (!/already running/i.test(String((error as any)?.message || error))) throw error
  }
  const authKey = sandbox.stream.getAuthKey()
  // Same-origin noVNC URLs (our /novnc client + backend websockify proxy) —
  // the E2B-hosted vnc.html is unreachable behind the app CSP.
  const urls = buildVncUrls(String(sandbox.sandboxId), authKey)
  return {
    streamUrl: urls.viewUrl,
    interactiveUrl: urls.interactiveUrl,
    streamAuthKey: authKey,
  }
}

/** Persist the stream credentials next to the box row so ANY process (after
 *  a restart, the API vs the worker) can rebuild the noVNC URLs — the SDK
 *  forgets them the moment the instance that started the stream dies. */
async function rememberBoxStream(userId: string, sandboxId: string, stream: { streamUrl: string; interactiveUrl: string | null; streamAuthKey: string | null }): Promise<void> {
  if (!prisma) return
  await prisma.botBox.update({
    where: { userId },
    data: {
      sandboxId,
      streamAuthKey: stream.streamAuthKey,
      streamUrl: stream.streamUrl || null,
      interactiveUrl: stream.interactiveUrl,
      streamStartedAt: stream.streamUrl ? new Date() : null,
    },
  }).catch(() => undefined)
}

/**
 * Get (or boot/resume) the caller's persistent box, seeded for a task type.
 * Concurrency-safe per user: concurrent callers share the in-flight boot.
 */
const pendingBoots = new Map<string, Promise<BoxSpec>>()

/** Daily VM-minute budget → sandbox idle timeout.
 *  Soft mode (resume/reconnect): never throw on quota — return a short keepalive
 *  so an already-alive box can still stream when today's minutes are spent.
 *  Hard mode (lease extend): throws forbidden/quota like remainingVmMinutes.
 *  Cold boot does not use this; it uses bootTimeoutPlan so create stays up
 *  long enough to finish, then shrinks back to this budget. */
async function boxTimeoutMs(userId: string, mode: 'soft' | 'hard' = 'hard'): Promise<number> {
  const { remainingVmMinutes, AgentTaskError } = await import('./agentTasks')
  try {
    const remaining = await remainingVmMinutes(userId)
    if (!Number.isFinite(remaining) || remaining >= 24 * 60) return BOX_IDLE_TTL_MS
    return Math.min(BOX_IDLE_TTL_MS, Math.max(60_000, Math.floor(remaining) * 60_000))
  } catch (err) {
    if (mode === 'soft' && err instanceof AgentTaskError && (err.code === 'quota' || err.code === 'forbidden')) {
      return SOFT_KEEPALIVE_MS
    }
    throw err
  }
}

/** Sandbox.connect / Sandbox.create timeout: at least 10 minutes, at most the
 *  provider's 1 hour cap. Shrink to the daily remainder only after the stream is up. */
export function sandboxConnectTimeoutMs(desiredMs?: number): number {
  const desired = typeof desiredMs === 'number' && Number.isFinite(desiredMs) ? desiredMs : MIN_BOOT_TIMEOUT_MS
  return Math.min(BOX_IDLE_TTL_MS, Math.max(MIN_BOOT_TIMEOUT_MS, desired))
}

/** Lease a task may apply to the shared persistent box. This is the box's own
 *  budget (or the short soft keepalive when the day is spent), never a task TTL. */
export async function sharedBoxAttachBudget(userId: string): Promise<number> {
  try {
    return await boxTimeoutMs(userId, 'soft')
  } catch {
    return SOFT_KEEPALIVE_MS
  }
}

/** In-process desktop handle, if this process has one. Does not connect. */
export function getLiveUserBox(userId: string): Sandbox | null {
  return liveBoxes.get(userId)?.sandbox ?? null
}

/** SDK error when the sandbox dies while create/connect still has a stream open. */
function isSandboxStreamTimeout(error: unknown): boolean {
  const msg = String((error as { message?: string })?.message || error || '')
  return /ended before the stream completed/i.test(msg) || /sandbox timeout/i.test(msg)
}

function logDesktopStreamDeath(userId: string, error: unknown, sandboxId?: string): void {
  console.warn('[bot-box] desktop stream ended before boot finished', {
    userId,
    ...(sandboxId ? { sandboxId } : {}),
    error: String((error as { message?: string })?.message || error),
  })
}

/** Create/connect lifetime. Throws the same quota/forbidden errors as
 *  remainingVmMinutes, and quota when fewer than 5 minutes remain — a new
 *  desktop cannot finish inside that window. bootMs is at least 10 minutes
 *  and never above the provider's 1 hour cap. budgetMs is the real remainder. */
async function bootTimeoutPlan(userId: string): Promise<{ bootMs: number; budgetMs: number }> {
  const { remainingVmMinutes, AgentTaskError } = await import('./agentTasks')
  const remaining = await remainingVmMinutes(userId)
  if (!Number.isFinite(remaining) || remaining >= 24 * 60) {
    return { bootMs: BOX_IDLE_TTL_MS, budgetMs: BOX_IDLE_TTL_MS }
  }
  if (remaining < BOOT_QUOTA_FLOOR_MINUTES) throw new AgentTaskError('quota')
  const minutesMs = Math.floor(remaining) * 60_000
  return {
    bootMs: Math.min(BOX_IDLE_TTL_MS, Math.max(MIN_BOOT_TIMEOUT_MS, minutesMs)),
    budgetMs: Math.min(BOX_IDLE_TTL_MS, Math.max(60_000, minutesMs)),
  }
}

/** Timeout passed to Sandbox.connect before any command or stream.start.
 *  An existing box still reconnects when fewer than 5 minutes remain — that
 *  floor only blocks Sandbox.create. The connect itself always gets at least
 *  10 minutes (and at most 1 hour) so the stream can finish, then setTimeout
 *  shrinks to budgetMs. A spent budget shrinks to the short soft keepalive. */
async function connectTimeoutForUser(userId: string): Promise<{ connectMs: number; budgetMs: number }> {
  const { remainingVmMinutes, AgentTaskError } = await import('./agentTasks')
  try {
    const remaining = await remainingVmMinutes(userId)
    if (!Number.isFinite(remaining) || remaining >= 24 * 60) {
      return { connectMs: BOX_IDLE_TTL_MS, budgetMs: BOX_IDLE_TTL_MS }
    }
    const minutesMs = Math.floor(remaining) * 60_000
    const budgetMs = Math.min(BOX_IDLE_TTL_MS, Math.max(60_000, minutesMs))
    const connectMs = sandboxConnectTimeoutMs(minutesMs)
    return { connectMs, budgetMs }
  } catch (err) {
    if (err instanceof AgentTaskError && (err.code === 'quota' || err.code === 'forbidden')) {
      const budgetMs = await boxTimeoutMs(userId, 'soft')
      return { connectMs: sandboxConnectTimeoutMs(), budgetMs }
    }
    throw err
  }
}

/** The provider says this VM no longer exists. A timeout or network error is not this. */
function isProviderSandboxGone(error: unknown): boolean {
  const status = (error as { status?: number; response?: { status?: number } })?.status
    ?? (error as { response?: { status?: number } })?.response?.status
  if (status === 404) return true
  const msg = String((error as { message?: string })?.message || error || '')
  return /not found|does not exist|no such sandbox|unknown sandbox/i.test(msg)
}

function isRetryableProviderError(error: unknown): boolean {
  if (isProviderSandboxGone(error)) return false
  if (isSandboxStreamTimeout(error)) return true
  const msg = String((error as { message?: string })?.message || error || '')
  return /timeout|timed out|etimedout|econn|enotfound|eai_again|network|socket|fetch failed|503|502|504|temporarily/i.test(msg)
}

async function retryableDesktopError(): Promise<Error> {
  const { AgentTaskError } = await import('./agentTasks')
  return new AgentTaskError('unavailable', DESKTOP_BOOT_RETRY_MESSAGE)
}

async function rememberBox(userId: string, sandboxId: string): Promise<void> {
  if (!prisma) return
  await prisma.botBox.upsert({
    where: { userId },
    create: { userId, sandboxId },
    update: { sandboxId },
  }).catch(() => undefined)
}

async function clearBoxSandboxId(userId: string): Promise<void> {
  liveBoxes.delete(userId)
  if (!prisma) return
  await prisma.botBox.update({
    where: { userId },
    data: { sandboxId: '' },
  }).catch(() => undefined)
}

interface PersistedStream {
  streamUrl: string
  interactiveUrl: string | null
}

/** Reconnect a box recorded in the database. A dead id falls through to a
 *  fresh boot. Also returns the persisted stream URLs: the reconnected SDK
 *  instance never owned the stream, so it cannot rebuild them itself. */
async function connectPersistedBox(userId: string, timeoutMs: number): Promise<{ sandbox: Sandbox; stream: PersistedStream | null } | null> {
  if (!prisma) return null
  const row = await prisma.botBox.findUnique({ where: { userId } }).catch(() => null)
  if (!row?.sandboxId) return null
  try {
    const { Sandbox } = await import('@e2b/desktop')
    // timeoutMs must be set on connect. The sandbox's old deadline is often
    // already due, and the SDK stream dies before a later setTimeout runs.
    const sandbox = await Sandbox.connect(row.sandboxId, { timeoutMs })
    let stream: PersistedStream | null = null
    if (row.streamAuthKey) {
      // Strongest path: rebuild fresh URLs from the persisted auth key.
      const urls = buildVncUrls(row.sandboxId, row.streamAuthKey)
      stream = { streamUrl: urls.viewUrl, interactiveUrl: urls.interactiveUrl }
    } else if (row.streamUrl) {
      stream = { streamUrl: row.streamUrl, interactiveUrl: row.interactiveUrl }
    }
    return { sandbox, stream }
  } catch (error) {
    if (isProviderSandboxGone(error)) return null
    throw error
  }
}

async function coldBootOnce(userId: string, userLabel: string, taskType: BoxTaskType, pauseOnTimeout: boolean): Promise<BoxSpec> {
  if (!isE2BConfigured()) {
    throw new Error('E2B is not configured on this deployment — the bot cannot boot its computer.')
  }
  // Refuse a new VM when fewer than 5 minutes remain (or the budget is already
  // spent). The Computer tab maps this quota error to the daily-budget message.
  const { bootMs, budgetMs } = await bootTimeoutPlan(userId)
  const template = desktopTemplateId()
  if (!template) {
    throw new Error(
      'E2B_DESKTOP_TEMPLATE is required for bot Computer boot (GNOME image). Build infra/e2b-gnome-desktop and set the template id.',
    )
  }
  const { Sandbox: DesktopSandbox } = await import('@e2b/desktop')
  // First arg is the template id/alias — passing only { template } can fall
  // back to the stock XFCE image (no GNOME binaries).
  const createOptions: Record<string, unknown> = {
    timeoutMs: bootMs,
    metadata: { loopGpt: 'bot-box', userId },
  }
  // Pause-on-timeout is the first attempt. Some accounts end the create stream
  // when that lifecycle is rejected, so the single retry omits it.
  if (pauseOnTimeout) createOptions.lifecycle = { onTimeout: 'pause', autoResume: true }
  const sandbox: Sandbox = await DesktopSandbox.create(template, createOptions)

  // Track the VM before GNOME/seeding. Otherwise the reaper sees an untracked
  // loopGpt:bot-box sandbox and kills it mid-boot.
  await rememberBox(userId, sandbox.sandboxId)
  const state: BoxState = {
    sandboxId: sandbox.sandboxId,
    sandbox,
    createdAt: Date.now(),
    lastTouchedAt: Date.now(),
  }
  liveBoxes.set(userId, state)

  try {
    // GNOME-first: do not return Computer / stream until GNOME owns the
    // display. The SDK still starts its XFCE shim; we block on the swap.
    await awaitGnomeDesktop(sandbox)
    await runInBox(sandbox, 'mkdir -p /workspace /home/user/Desktop')
    // A fresh box is empty; the user's files come back from the durable mirror
    // before any seeding writes anything, so a restore never clobbers a seed
    // and a seed never clobbers a restored file.
    const restored = await restoreWorkspaceIn(sandbox, userId)
    await seedBoxProfile(sandbox, userLabel, taskType)
    await seedBotHomes(sandbox, userId)
    if (restored) console.info('[bot-box] workspace restored from durable mirror', { userId })

    const stream = await readVncUrls(sandbox)
    await rememberBoxStream(userId, sandbox.sandboxId, stream)
    // Boot used a >=10 minute timeout so the stream could finish. Shrink back
    // to the real daily remainder so a short allowance is not held for an hour.
    await sandbox.setTimeout(budgetMs).catch((error: unknown) => {
      console.warn('[bot-box] could not shrink sandbox timeout to the remaining budget', String((error as Error)?.message || error))
    })
    console.info('[bot-box] booted persistent box', { userId, sandboxId: sandbox.sandboxId, taskType, template })
    return {
      sandboxId: sandbox.sandboxId,
      streamUrl: stream.streamUrl,
      interactiveUrl: stream.interactiveUrl,
      resumed: false,
      ageMinutes: 0,
      taskType,
      workspaceDir: '/workspace',
    }
  } catch (error) {
    await sandbox.kill().catch(() => undefined)
    await clearBoxSandboxId(userId)
    throw error
  }
}

/** One cold boot, plus a single retry without pause-on-timeout when the
 *  create/connect stream dies. A second stream failure is a short message
 *  with no sandbox id (that id stays in the server log). */
async function finishColdBoot(userId: string, userLabel: string, taskType: BoxTaskType, pauseFirst: boolean): Promise<BoxSpec> {
  try {
    return await coldBootOnce(userId, userLabel, taskType, pauseFirst)
  } catch (error) {
    if (!isSandboxStreamTimeout(error)) throw error
    logDesktopStreamDeath(userId, error)
    await clearBoxSandboxId(userId)
    if (!pauseFirst) throw new Error(DESKTOP_BOOT_RETRY_MESSAGE)
    try {
      return await coldBootOnce(userId, userLabel, taskType, false)
    } catch (second) {
      await clearBoxSandboxId(userId)
      if (isSandboxStreamTimeout(second)) {
        logDesktopStreamDeath(userId, second)
        throw new Error(DESKTOP_BOOT_RETRY_MESSAGE)
      }
      throw second
    }
  }
}

/** Rewrite each bot's desktop MEMORY.md from the durable memory file.
 *  The first boot used to seed the file only when it was missing, so later
 *  remember_fact notes never landed. Wake always rewrites. A down box is a no-op
 *  here; the next successful wake performs the rewrite. */
async function rewriteDesktopMemory(sandbox: Sandbox, userId: string, onlyBotId?: string): Promise<void> {
  if (!prisma) return
  try {
    const bots = onlyBotId
      ? [{ id: onlyBotId }]
      : await prisma.bot.findMany({ where: { ownerId: userId }, select: { id: true } })
    for (const bot of bots) {
      const mirror = readBotMemory(userId, bot.id)
      if (!mirror) continue
      const home = `/workspace/agents/${bot.id}`
      await runInBox(sandbox, `mkdir -p ${quote(home)} && printf '%s\\n' ${quote(mirror)} > ${quote(`${home}/MEMORY.md`)}`)
    }
  } catch { /* memory mirror is best-effort */ }
}

/** When the box is already up in this process, refresh one bot's MEMORY.md.
 *  If the box is down, the next wake rewrites it from the memory file. */
export async function syncLiveBoxMemory(userId: string, botId: string): Promise<void> {
  const sandbox = getLiveUserBox(userId)
  if (!sandbox) return
  await rewriteDesktopMemory(sandbox, userId, botId)
}

export async function ensureUserBox(userId: string, userLabel: string, taskType: BoxTaskType = 'default'): Promise<BoxSpec> {
  const pending = pendingBoots.get(userId)
  if (pending) return pending

  const boot = (async (): Promise<BoxSpec> => {
    const existing = liveBoxes.get(userId)
    if (existing) {
      try {
        // Resume path: soft quota — do not 402 an already-live desktop.
        const timeoutMs = await boxTimeoutMs(userId, 'soft')
        // Touch to keep alive; resume if paused. Timeout stays inside the daily budget.
        await existing.sandbox.setTimeout(timeoutMs)
        existing.lastTouchedAt = Date.now()
        syncWorkspaceThrottled(existing.sandbox, userId)
        const stream = await readVncUrls(existing.sandbox)
        await rememberBoxStream(userId, existing.sandboxId, stream)
        await rewriteDesktopMemory(existing.sandbox, userId)
        return {
          sandboxId: existing.sandboxId,
          streamUrl: stream.streamUrl,
          interactiveUrl: stream.interactiveUrl,
          resumed: true,
          ageMinutes: Math.max(0, Math.round((Date.now() - existing.createdAt) / 60_000)),
          taskType,
          workspaceDir: '/workspace',
        }
      } catch {
        liveBoxes.delete(userId) // dead — fall through to a fresh boot
      }
    }

    const timeouts = await connectTimeoutForUser(userId)
    let connected: { sandbox: Sandbox; stream: PersistedStream | null } | null = null
    try {
      connected = await connectPersistedBox(userId, timeouts.connectMs)
    } catch (error) {
      // Timeout or network: keep sandboxId and ask the caller to retry.
      // A missing VM returns null from connect and falls through to a cold boot.
      if (!isRetryableProviderError(error)) throw error
      logDesktopStreamDeath(userId, error)
      throw await retryableDesktopError()
    }

    if (connected) {
      try {
        const state: BoxState = {
          sandboxId: connected.sandbox.sandboxId,
          sandbox: connected.sandbox,
          createdAt: Date.now(),
          lastTouchedAt: Date.now(),
        }
        liveBoxes.set(userId, state)
        // The reconnected SDK instance never owned the stream — it cannot
        // rebuild the URLs itself. Use the credentials persisted at boot; only
        // if they are missing (pre-migration row) do we ask the SDK, whose
        // answer may legitimately be empty until the stream is restarted.
        // Keep the long connect timeout until that stream is up.
        let streamUrl = connected.stream?.streamUrl || ''
        let interactiveUrl = connected.stream?.interactiveUrl || null
        if (!streamUrl) {
          try {
            const stream = await readVncUrls(connected.sandbox)
            streamUrl = stream.streamUrl
            interactiveUrl = stream.interactiveUrl
            await rememberBoxStream(userId, state.sandboxId, stream)
          } catch (error) {
            if (isSandboxStreamTimeout(error)) throw error
            /* stream state unknown to this instance — stays empty */
          }
        }
        await connected.sandbox.setTimeout(timeouts.budgetMs).catch((error: unknown) => {
          console.warn('[bot-box] could not shrink sandbox timeout to the remaining budget', String((error as Error)?.message || error))
        })
        await rewriteDesktopMemory(connected.sandbox, userId)
        return {
          sandboxId: state.sandboxId,
          streamUrl,
          interactiveUrl,
          resumed: true,
          ageMinutes: 0,
          taskType,
          workspaceDir: '/workspace',
        }
      } catch (error) {
        liveBoxes.delete(userId)
        if (isProviderSandboxGone(error)) {
          await clearBoxSandboxId(userId)
        } else {
          logDesktopStreamDeath(userId, error, connected.sandbox?.sandboxId)
          throw await retryableDesktopError()
        }
      }
    }

    // The provider confirmed the sandbox is gone (or there was no id).
    await clearBoxSandboxId(userId)
    return finishColdBoot(userId, userLabel, taskType, true)
  })()

  pendingBoots.set(userId, boot)
  try {
    return await boot
  } finally {
    pendingBoots.delete(userId)
  }
}

export async function attachUserBoxFromDB(userId: string): Promise<string | null> {
  if (!prisma) return null
  try {
    const row = await prisma.botBox.findUnique({ where: { userId }, select: { sandboxId: true } })
    if (!row?.sandboxId) return null
    return row.sandboxId
  } catch {
    return null
  }
}

/** Detach in-process box handles without killing provider VMs. The API process
 *  must never kill every user's box on SIGTERM — only clear local refs so the
 *  next boot reconnects. The worker drains its own in-flight tasks separately. */
export async function detachAllBoxes(): Promise<void> {
  liveBoxes.clear()
  pendingBoots.clear()
}

/** @deprecated Prefer detachAllBoxes — killing every box on API shutdown is wrong. */
export async function syncAndKillAllBoxes(): Promise<void> {
  await detachAllBoxes()
}

const BOX_IDLE_REAP_MS = 2 * 60 * 60_000

/** Every 5 minutes, kill stale bot boxes whose keep-alive window expired.
 *  Sync the workspace first, re-check updatedAt inside the kill step so a box
 *  the user just touched isn't killed, and sweep untracked provider sandboxes
 *  tagged with our metadata. */
export async function reapOrphanBoxes(): Promise<void> {
  if (!prisma) return
  try {
    const twoHoursAgo = new Date(Date.now() - BOX_IDLE_REAP_MS)
    const stale = await prisma.botBox.findMany({
      where: { sandboxId: { not: '' }, updatedAt: { lt: twoHoursAgo } },
      select: { userId: true, sandboxId: true, updatedAt: true },
    })
    for (const row of stale) {
      if (!row.sandboxId) continue
      // Re-check freshness: a concurrent wake/heartbeat may have just touched it.
      const fresh = await prisma.botBox.findUnique({
        where: { userId: row.userId },
        select: { sandboxId: true, updatedAt: true },
      }).catch(() => null)
      if (!fresh?.sandboxId || fresh.sandboxId !== row.sandboxId) continue
      if (fresh.updatedAt.getTime() >= Date.now() - BOX_IDLE_REAP_MS) continue
      try {
        const { Sandbox } = await import('@e2b/desktop')
        const handle = await Sandbox.connect(row.sandboxId, { timeoutMs: sandboxConnectTimeoutMs() })
        try { await syncWorkspaceOut(handle, row.userId) } catch { /* best effort */ }
        // Final freshness check after the (slow) sync.
        const again = await prisma.botBox.findUnique({
          where: { userId: row.userId },
          select: { updatedAt: true, sandboxId: true },
        }).catch(() => null)
        if (!again || again.sandboxId !== row.sandboxId) continue
        if (again.updatedAt.getTime() >= Date.now() - BOX_IDLE_REAP_MS) continue
        await handle.kill().catch(() => undefined)
        await prisma.botBox.update({ where: { userId: row.userId }, data: { sandboxId: '' } }).catch(() => undefined)
        liveBoxes.delete(row.userId)
        console.info('[bot-box] reaped stale sandbox', { userId: row.userId, sandboxId: row.sandboxId })
      } catch (error) {
        // Clear the id only after the provider says the sandbox is gone.
        // A timeout or network error leaves it so the next wake can retry.
        if (!isProviderSandboxGone(error)) {
          console.warn('[bot-box] reaper could not reach sandbox; leaving sandboxId', {
            userId: row.userId,
            sandboxId: row.sandboxId,
            error: String((error as Error)?.message || error),
          })
          continue
        }
        await prisma.botBox.update({ where: { userId: row.userId }, data: { sandboxId: '' } }).catch(() => undefined)
        liveBoxes.delete(row.userId)
      }
    }
    await reapUntrackedSandboxes()
  } catch { /* best effort */ }
}

/** True when the provider says this VM started less than 15 minutes ago.
 *  Missing or unreadable timestamps are not treated as young — those sandboxes
 *  stay eligible for the untracked sweep. */
function sandboxStartedRecently(info: { startedAt?: Date | string | number | null }): boolean {
  const raw = info?.startedAt
  if (raw == null || raw === '') return false
  const started = raw instanceof Date ? raw.getTime() : new Date(raw).getTime()
  if (!Number.isFinite(started)) return false
  return Date.now() - started < UNTRACKED_BOOT_GRACE_MS
}

/** Kill provider sandboxes tagged as ours that no BotBox / recent BotRun tracks. */
async function reapUntrackedSandboxes(): Promise<void> {
  if (!prisma || !isE2BConfigured()) return
  try {
    const { Sandbox } = await import('@e2b/desktop')
    const tracked = new Set<string>()
    const boxes = await prisma.botBox.findMany({
      where: { sandboxId: { not: '' } },
      select: { sandboxId: true },
    }).catch(() => [])
    for (const row of boxes) if (row.sandboxId) tracked.add(row.sandboxId)
    const recent = await prisma.botRun.findMany({
      where: { status: 'running', startedAt: { gt: new Date(Date.now() - BOX_IDLE_REAP_MS) } },
      select: { computer: true },
      take: 200,
    }).catch(() => [])
    for (const run of recent) {
      const id = (run.computer as { sandboxId?: string } | null)?.sandboxId
      if (id) tracked.add(id)
    }
    const paginator = Sandbox.list({ query: { metadata: { loopGpt: 'bot-box' } } })
    while (paginator.hasNext) {
      const page = await paginator.nextItems()
      for (const info of page) {
        const id = String(info.sandboxId || '')
        if (!id || tracked.has(id) || sandboxStartedRecently(info)) continue
        try {
          const handle = await Sandbox.connect(id, { timeoutMs: sandboxConnectTimeoutMs() })
          await handle.kill().catch(() => undefined)
          console.info('[bot-box] reaped untracked sandbox', { sandboxId: id })
        } catch { /* already gone */ }
      }
    }
    // Dedicated per-run VMs use a different metadata tag.
    const desktopPager = Sandbox.list({ query: { metadata: { loopGpt: 'bot-desktop' } } })
    while (desktopPager.hasNext) {
      const page = await desktopPager.nextItems()
      for (const info of page) {
        const id = String(info.sandboxId || '')
        if (!id || tracked.has(id) || sandboxStartedRecently(info)) continue
        try {
          const handle = await Sandbox.connect(id, { timeoutMs: sandboxConnectTimeoutMs() })
          await handle.kill().catch(() => undefined)
          console.info('[bot-box] reaped untracked desktop sandbox', { sandboxId: id })
        } catch { /* already gone */ }
      }
    }
  } catch (error) {
    console.warn('[bot-box] untracked sandbox sweep failed', String((error as Error)?.message || error))
  }
}

/** Create (and remember) a per-task folder inside the user's box workspace.
 *  Connects by the box id from BotBox — the worker process does not share the
 *  API's in-memory liveBoxes map. */
export async function createBoxTaskFolder(userId: string, taskId: string, goal: string): Promise<string> {
  const sandboxId = await attachUserBoxFromDB(userId)
  if (!sandboxId) return '/workspace'
  const dir = `/workspace/task-folders/${taskId.slice(0, 8)}`
  try {
    const { Sandbox } = await import('@e2b/desktop')
    const timeouts = await connectTimeoutForUser(userId).catch(() => ({ connectMs: sandboxConnectTimeoutMs(), budgetMs: sandboxConnectTimeoutMs() }))
    const sandbox = liveBoxes.get(userId)?.sandbox || await Sandbox.connect(sandboxId, { timeoutMs: timeouts.connectMs })
    await sandbox.commands.run(
      `mkdir -p ${quote(dir)} && printf '%s\\n' ${quote(`# ${goal}\n# task ${taskId} — created ${new Date().toISOString()}`)} > ${quote(`${dir}/TASK.md`)}`,
      { timeoutMs: 20_000 },
    )
    return dir
  } catch {
    return '/workspace'
  }
}

/** Extend the box timeout and bump BotBox.updatedAt while a task is attached
 *  so the reaper never kills an active box. */
export async function extendUserBoxLease(userId: string): Promise<void> {
  if (!prisma) return
  const timeoutMs = await boxTimeoutMs(userId, 'soft').catch(() => SOFT_KEEPALIVE_MS)
  const live = liveBoxes.get(userId)
  if (live) {
    try {
      await live.sandbox.setTimeout(timeoutMs)
      live.lastTouchedAt = Date.now()
    } catch { /* reconnect path below */ }
  } else {
    const row = await prisma.botBox.findUnique({ where: { userId }, select: { sandboxId: true } }).catch(() => null)
    if (row?.sandboxId) {
      try {
        const { Sandbox } = await import('@e2b/desktop')
        const sandbox = await Sandbox.connect(row.sandboxId, { timeoutMs: sandboxConnectTimeoutMs(timeoutMs) })
        await sandbox.setTimeout(timeoutMs)
        liveBoxes.set(userId, {
          sandboxId: row.sandboxId,
          sandbox,
          createdAt: Date.now(),
          lastTouchedAt: Date.now(),
        })
      } catch { /* box may be paused/dead — next ensureUserBox resumes */ }
    }
  }
  await prisma.botBox.update({
    where: { userId },
    data: { updatedAt: new Date() },
  }).catch(() => undefined)
}

export class BoxNotConnectedError extends Error {
  readonly code = 'not_connected'
  constructor() {
    super('The computer is not connected. Wake it before taking control.')
  }
}

export interface ComputerStatus {
  alive: boolean
  paused: boolean
  takeoverRequested: boolean
  sandboxId: string | null
  viewUrl: string | null
  interactiveUrl: string | null
  resumed: boolean
  ageMinutes: number | null
  taskType: BoxTaskType | null
  workspaceDir: string
}

function emptyComputerStatus(): ComputerStatus {
  return {
    alive: false,
    paused: false,
    takeoverRequested: false,
    sandboxId: null,
    viewUrl: null,
    interactiveUrl: null,
    resumed: false,
    ageMinutes: null,
    taskType: null,
    workspaceDir: '/workspace',
  }
}

/** Probe the in-process handle. A stored sandbox id with no live handle is
 *  paused, not alive, and has no stream URLs. */
async function probeLiveBox(userId: string, sandboxId: string): Promise<{ ageMinutes: number } | null> {
  const live = liveBoxes.get(userId)
  if (!live || live.sandboxId !== sandboxId) return null
  try {
    await live.sandbox.commands.run('true', { timeoutMs: 5_000 })
    return { ageMinutes: Math.max(0, Math.round((Date.now() - live.createdAt) / 60_000)) }
  } catch {
    liveBoxes.delete(userId)
    return null
  }
}

/** Read-only computer status for GET /computer. Does not boot or resume. */
export async function getComputerStatus(userId: string): Promise<ComputerStatus> {
  if (!prisma) return emptyComputerStatus()
  const row = await prisma.botBox.findUnique({ where: { userId } }).catch(() => null)
  if (!row?.sandboxId) return emptyComputerStatus()
  const takeoverRequested = row.takeoverRequested === true
  const paused: ComputerStatus = {
    ...emptyComputerStatus(),
    paused: true,
    takeoverRequested,
    sandboxId: row.sandboxId,
    taskType: 'default',
  }
  const probed = await probeLiveBox(userId, row.sandboxId)
  if (!probed) return paused
  let viewUrl = row.streamUrl || null
  let interactiveUrl = row.interactiveUrl || null
  if (row.streamAuthKey) {
    const urls = buildVncUrls(row.sandboxId, row.streamAuthKey)
    viewUrl = urls.viewUrl
    interactiveUrl = urls.interactiveUrl
  }
  return {
    alive: true,
    paused: false,
    takeoverRequested,
    sandboxId: row.sandboxId,
    viewUrl: viewUrl || null,
    interactiveUrl: takeoverRequested ? (interactiveUrl || null) : null,
    resumed: true,
    ageMinutes: probed.ageMinutes,
    taskType: 'default',
    workspaceDir: '/workspace',
  }
}

/** Read-only stream state. Alive only after a successful in-process probe. */
export async function getBoxStreamState(userId: string): Promise<{
  alive: boolean
  sandboxId?: string
  viewUrl?: string | null
  interactiveUrl?: string | null
  ageMinutes?: number
  taskType?: BoxTaskType
  workspaceDir?: string
} | null> {
  const status = await getComputerStatus(userId)
  if (!status.sandboxId) return { alive: false }
  return {
    alive: status.alive,
    sandboxId: status.sandboxId,
    viewUrl: status.viewUrl,
    interactiveUrl: status.interactiveUrl,
    ageMinutes: status.ageMinutes ?? undefined,
    taskType: status.taskType || 'default',
    workspaceDir: status.workspaceDir,
  }
}

/** Box health. A stored id this process has not probed is not alive. */
export async function getUserBoxStatus(userId: string): Promise<{ alive: boolean; sandboxId?: string; ageMinutes?: number }> {
  const status = await getComputerStatus(userId)
  if (!status.sandboxId) return { alive: false }
  return {
    alive: status.alive,
    sandboxId: status.sandboxId,
    ...(status.ageMinutes != null ? { ageMinutes: status.ageMinutes } : {}),
  }
}

/** Persistent-box operator control. Does not boot. 409 when the box is not connected. */
export async function setUserBoxTakeover(userId: string, takeover: boolean): Promise<{ takeoverRequested: boolean; interactiveUrl: string | null }> {
  const status = await getComputerStatus(userId)
  if (!status.alive || !status.sandboxId) throw new BoxNotConnectedError()
  if (prisma) {
    await prisma.botBox.update({
      where: { userId },
      data: { takeoverRequested: takeover },
    })
  }
  if (!takeover) return { takeoverRequested: false, interactiveUrl: null }
  const again = await getComputerStatus(userId)
  return { takeoverRequested: true, interactiveUrl: again.interactiveUrl }
}

/** Graceful shutdown (deploys / restarts): sync every workspace out first —
 *  a deploy must never cost the user their files. */
export async function killAllBoxes(): Promise<void> {
  for (const [userId, state] of liveBoxes) {
    try { await syncWorkspaceOut(state.sandbox, userId) } catch { /* best effort */ }
    try { await state.sandbox.kill() } catch { /* best effort */ }
  }
  liveBoxes.clear()
}

/** Force a workspace sync for a live box (called when a task finishes, so the
 *  durable mirror is never more than one task stale). */
export async function syncUserBoxNow(userId: string): Promise<void> {
  const sandboxId = await attachUserBoxFromDB(userId)
  if (sandboxId) {
    const sandbox = await (await import('@e2b/desktop')).Sandbox.connect(sandboxId, { timeoutMs: sandboxConnectTimeoutMs() })
    await syncWorkspaceOut(sandbox, userId)
  }
}

/** Seed a home for one bot inside the user's live box (called when a bot is
 *  created while the box is up; the boot path seeds all of them). */
export async function seedBotHomeNow(userId: string, botId: string, botName: string): Promise<void> {
  const sandboxId = await attachUserBoxFromDB(userId)
  if (!sandboxId) return
  const sandbox = await (await import('@e2b/desktop')).Sandbox.connect(sandboxId, { timeoutMs: sandboxConnectTimeoutMs() })
  try {
    const home = `/workspace/agents/${botId}`
    const mirror = readBotMemory(userId, botId)
    await runInBox(sandbox, [
      `mkdir -p ${quote(home)} /workspace/shared`,
      `[ -f ${quote(`${home}/README.md`)} ] || printf '# %s\\nHome of bot %s. Files here persist; /workspace/shared is visible to every bot.\\n' ${quote(botName)} ${quote(botId)} > ${quote(`${home}/README.md`)}`,
      ...(mirror ? [`printf '%s\\n' ${quote(mirror)} > ${quote(`${home}/MEMORY.md`)}`] : []),
    ].join(' && '))
  } catch { /* best effort */ }
}
