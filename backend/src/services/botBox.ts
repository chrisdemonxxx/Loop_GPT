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
        ...(mirror ? [`[ -f ${quote(`${home}/MEMORY.md`)} ] || printf '%s\\n' ${quote(mirror)} > ${quote(`${home}/MEMORY.md`)}`] : []),
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
 *  Hard mode (cold boot): throws forbidden/quota like remainingVmMinutes. */
async function boxTimeoutMs(userId: string, mode: 'soft' | 'hard' = 'hard'): Promise<number> {
  const { remainingVmMinutes, AgentTaskError } = await import('./agentTasks')
  try {
    const remaining = await remainingVmMinutes(userId)
    if (!Number.isFinite(remaining) || remaining >= 24 * 60) return BOX_IDLE_TTL_MS
    return Math.min(BOX_IDLE_TTL_MS, Math.max(60_000, Math.floor(remaining) * 60_000))
  } catch (err) {
    if (mode === 'soft' && err instanceof AgentTaskError && (err.code === 'quota' || err.code === 'forbidden')) {
      return 60_000
    }
    throw err
  }
}

async function rememberBox(userId: string, sandboxId: string): Promise<void> {
  if (!prisma) return
  await prisma.botBox.upsert({
    where: { userId },
    create: { userId, sandboxId },
    update: { sandboxId },
  }).catch(() => undefined)
}

interface PersistedStream {
  streamUrl: string
  interactiveUrl: string | null
}

/** Reconnect a box recorded in the database. A dead id falls through to a
 *  fresh boot. Also returns the persisted stream URLs: the reconnected SDK
 *  instance never owned the stream, so it cannot rebuild them itself. */
async function connectPersistedBox(userId: string): Promise<{ sandbox: Sandbox; stream: PersistedStream | null } | null> {
  if (!prisma) return null
  const row = await prisma.botBox.findUnique({ where: { userId } }).catch(() => null)
  if (!row?.sandboxId) return null
  try {
    const { Sandbox } = await import('@e2b/desktop')
    const sandbox = await Sandbox.connect(row.sandboxId)
    let stream: PersistedStream | null = null
    if (row.streamAuthKey) {
      // Strongest path: rebuild fresh URLs from the persisted auth key.
      const urls = buildVncUrls(row.sandboxId, row.streamAuthKey)
      stream = { streamUrl: urls.viewUrl, interactiveUrl: urls.interactiveUrl }
    } else if (row.streamUrl) {
      stream = { streamUrl: row.streamUrl, interactiveUrl: row.interactiveUrl }
    }
    return { sandbox, stream }
  } catch {
    return null
  }
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

    const connected = await connectPersistedBox(userId)
    if (connected) {
      try {
        // Reconnect path: soft quota — allow streaming an existing sandbox.
        const timeoutMs = await boxTimeoutMs(userId, 'soft')
        await connected.sandbox.setTimeout(timeoutMs)
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
        let streamUrl = connected.stream?.streamUrl || ''
        let interactiveUrl = connected.stream?.interactiveUrl || null
        if (!streamUrl) {
          try {
            const stream = await readVncUrls(connected.sandbox)
            streamUrl = stream.streamUrl
            interactiveUrl = stream.interactiveUrl
            await rememberBoxStream(userId, state.sandboxId, stream)
          } catch { /* stream state unknown to this instance — stays empty */ }
        }
        return {
          sandboxId: state.sandboxId,
          streamUrl,
          interactiveUrl,
          resumed: true,
          ageMinutes: 0,
          taskType,
          workspaceDir: '/workspace',
        }
      } catch {
        liveBoxes.delete(userId)
      }
    }

    if (!isE2BConfigured()) {
      throw new Error('E2B is not configured on this deployment — the bot cannot boot its computer.')
    }

    // Cold boot: hard quota — refuse new VMs when today's minutes are spent.
    const timeoutMs = await boxTimeoutMs(userId, 'hard')

    const template = desktopTemplateId()
    if (!template) {
      throw new Error(
        'E2B_DESKTOP_TEMPLATE is required for bot Computer boot (GNOME image). Build infra/e2b-gnome-desktop and set the template id.',
      )
    }
    const { Sandbox: DesktopSandbox } = await import('@e2b/desktop')
    // First arg is the template id/alias — passing only { template } can fall
    // back to the stock XFCE image (no GNOME binaries).
    const sandbox: Sandbox = await DesktopSandbox.create(template, {
      timeoutMs,
      // Pause on idle timeout so the next touch resumes quickly instead of cold-booting.
      lifecycle: { onTimeout: 'pause', autoResume: true },
      metadata: { loopGpt: 'bot-box', userId },
    })

    // GNOME-first: do not return Computer / stream until GNOME owns the
    // display. The SDK still starts its XFCE shim; we block on the swap.
    // Fail loudly — never paint XFCE to the operator.
    try {
      await awaitGnomeDesktop(sandbox)
    } catch (err) {
      await sandbox.kill().catch(() => undefined)
      throw err
    }

    await runInBox(sandbox, 'mkdir -p /workspace /home/user/Desktop')
    // A fresh box is empty; the user's files come back from the durable mirror
    // before any seeding writes anything, so a restore never clobbers a seed
    // and a seed never clobbers a restored file.
    const restored = await restoreWorkspaceIn(sandbox, userId)
    await seedBoxProfile(sandbox, userLabel, taskType)
    await seedBotHomes(sandbox, userId)
    if (restored) console.info('[bot-box] workspace restored from durable mirror', { userId })

    const state: BoxState = {
      sandboxId: sandbox.sandboxId,
      sandbox,
      createdAt: Date.now(),
      lastTouchedAt: Date.now(),
    }
    liveBoxes.set(userId, state)
    await rememberBox(userId, sandbox.sandboxId)

    const stream = await readVncUrls(sandbox)
    await rememberBoxStream(userId, sandbox.sandboxId, stream)
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
        const handle = await Sandbox.connect(row.sandboxId)
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
      } catch {
        // The sandbox is already dead (provider TTL), so the DB row is already
        // stale; clear the pointer to unblock the next cold-boot.
        await prisma.botBox.update({ where: { userId: row.userId }, data: { sandboxId: '' } }).catch(() => undefined)
        liveBoxes.delete(row.userId)
      }
    }
    await reapUntrackedSandboxes()
  } catch { /* best effort */ }
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
        if (!id || tracked.has(id)) continue
        try {
          const handle = await Sandbox.connect(id)
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
        if (!id || tracked.has(id)) continue
        try {
          const handle = await Sandbox.connect(id)
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
    const sandbox = liveBoxes.get(userId)?.sandbox || await Sandbox.connect(sandboxId)
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
  const timeoutMs = await boxTimeoutMs(userId).catch(() => BOX_IDLE_TTL_MS)
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
        const sandbox = await Sandbox.connect(row.sandboxId)
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

/** Read-only stream state for GET /computer (no boot/resume side effects). */
export async function getBoxStreamState(userId: string): Promise<{
  alive: boolean
  sandboxId?: string
  viewUrl?: string | null
  interactiveUrl?: string | null
  ageMinutes?: number
  taskType?: BoxTaskType
  workspaceDir?: string
} | null> {
  if (!prisma) return null
  const row = await prisma.botBox.findUnique({ where: { userId } }).catch(() => null)
  if (!row?.sandboxId) return { alive: false }
  let viewUrl = row.streamUrl
  let interactiveUrl = row.interactiveUrl
  if (row.streamAuthKey) {
    const urls = buildVncUrls(row.sandboxId, row.streamAuthKey)
    viewUrl = urls.viewUrl
    interactiveUrl = urls.interactiveUrl
  }
  const live = liveBoxes.get(userId)
  return {
    alive: true,
    sandboxId: row.sandboxId,
    viewUrl: viewUrl || null,
    interactiveUrl: interactiveUrl || null,
    ageMinutes: live
      ? Math.max(0, Math.round((Date.now() - live.createdAt) / 60_000))
      : undefined,
    workspaceDir: '/workspace',
  }
}

/** Box health for the Computer tab. Prefers the in-process handle; falls back
 *  to the persisted BotBox row (API vs worker don't share liveBoxes). */
export async function getUserBoxStatus(userId: string): Promise<{ alive: boolean; sandboxId?: string; ageMinutes?: number }> {
  const live = liveBoxes.get(userId)
  if (live) {
    try {
      await live.sandbox.commands.run('true', { timeoutMs: 5_000 })
      return { alive: true, sandboxId: live.sandboxId, ageMinutes: Math.max(0, Math.round((Date.now() - live.createdAt) / 60_000)) }
    } catch {
      liveBoxes.delete(userId)
    }
  }
  const sandboxId = await attachUserBoxFromDB(userId)
  if (!sandboxId) return { alive: false }
  return { alive: true, sandboxId }
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
    const sandbox = await (await import('@e2b/desktop')).Sandbox.connect(sandboxId)
    await syncWorkspaceOut(sandbox, userId)
  }
}

/** Seed a home for one bot inside the user's live box (called when a bot is
 *  created while the box is up; the boot path seeds all of them). */
export async function seedBotHomeNow(userId: string, botId: string, botName: string): Promise<void> {
  const sandboxId = await attachUserBoxFromDB(userId)
  if (!sandboxId) return
  const sandbox = await (await import('@e2b/desktop')).Sandbox.connect(sandboxId)
  try {
    const home = `/workspace/agents/${botId}`
    const mirror = readBotMemory(userId, botId)
    await runInBox(sandbox, [
      `mkdir -p ${quote(home)} /workspace/shared`,
      `[ -f ${quote(`${home}/README.md`)} ] || printf '# %s\\nHome of bot %s. Files here persist; /workspace/shared is visible to every bot.\\n' ${quote(botName)} ${quote(botId)} > ${quote(`${home}/README.md`)}`,
      ...(mirror ? [`[ -f ${quote(`${home}/MEMORY.md`)} ] || printf '%s\\n' ${quote(mirror)} > ${quote(`${home}/MEMORY.md`)}`] : []),
    ].join(' && '))
  } catch { /* best effort */ }
}
