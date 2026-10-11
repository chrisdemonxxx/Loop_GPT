import crypto from 'node:crypto'
import { buildVncUrls, isE2BConfigured } from './e2bDesktop'
import { prisma } from './prisma'

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
const BOOT_BUDGET_MS = 30 * 1000
const DEFAULT_SCREEN = { width: 1366, height: 768 }

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

  // Task-type tool packs — what appears ready-made on the desktop.
  const packs: Record<BoxTaskType, string[]> = {
    default: [],
    coding: [
      `mkdir -p /workspace/task-folders`,
      // terminal + editor + chrome, autostarted
      `mkdir -p /home/user/.config/autostart && printf '[Desktop Entry]\\nType=Application\\nName=Terminal\\nExec=xfce4-terminal --working-directory=/workspace\\nX-GNOME-Autostart-enabled=true\\n' > /home/user/.config/autostart/terminal.desktop`,
    ],
    research: [
      `mkdir -p /home/user/.config/autostart && printf '[Desktop Entry]\\nType=Application\\nName=Chrome\\nExec=google-chrome --start-maximized https://www.google.com\\nX-GNOME-Autostart-enabled=true\\n' > /home/user/.config/autostart/chrome.desktop`,
    ],
    ops: [
      `mkdir -p /home/user/.config/autostart && printf '[Desktop Entry]\\nType=Application\\nName=Terminal\\nExec=xfce4-terminal --working-directory=/workspace\\nX-GNOME-Autostart-enabled=true\\n' > /home/user/.config/autostart/terminal.desktop`,
      `mkdir -p /home/user/.config/autostart && printf '[Desktop Entry]\\nType=Application\\nName=Files\\nExec=thunar /workspace\\nX-GNOME-Autostart-enabled=true\\n' > /home/user/.config/autostart/files.desktop`,
    ],
    teach: [
      `mkdir -p /workspace/teach-sessions`,
      `mkdir -p /home/user/.config/autostart && printf '[Desktop Entry]\\nType=Application\\nName=Terminal\\nExec=xfce4-terminal --working-directory=/workspace\\nX-GNOME-Autostart-enabled=true\\n' > /home/user/.config/autostart/terminal.desktop`,
    ],
  }
  const cmds = packs[taskType] || packs.default
  if (cmds.length > 0) await runInBox(sandbox, cmds.join(' && '))
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
  return {
    streamUrl: sandbox.stream.getUrl({ viewOnly: true, authKey }),
    interactiveUrl: sandbox.stream.getUrl({ viewOnly: false, authKey }),
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

/** Daily VM-minute budget, clamped to the provider's idle cap. Throws when the plan or quota forbids a computer. */
async function boxTimeoutMs(userId: string): Promise<number> {
  const { remainingVmMinutes } = await import('./agentTasks')
  const remaining = await remainingVmMinutes(userId)
  if (!Number.isFinite(remaining) || remaining >= 24 * 60) return BOX_IDLE_TTL_MS
  return Math.min(BOX_IDLE_TTL_MS, Math.max(60_000, Math.floor(remaining) * 60_000))
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
    const timeoutMs = await boxTimeoutMs(userId)
    const existing = liveBoxes.get(userId)
    if (existing) {
      try {
        // Touch to keep alive; resume if paused. Timeout stays inside the daily budget.
        await existing.sandbox.setTimeout(timeoutMs)
        existing.lastTouchedAt = Date.now()
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

    const template = process.env.E2B_DESKTOP_TEMPLATE
    const { Sandbox: DesktopSandbox } = await import('@e2b/desktop')
    const sandbox: Sandbox = await DesktopSandbox.create({
      ...(template ? { template } : {}),
      timeoutMs,
      metadata: { loopGpt: 'bot-box', userId },
    })

    await runInBox(sandbox, 'mkdir -p /workspace /home/user/Desktop')
    await seedBoxProfile(sandbox, userLabel, taskType)

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
    console.info('[bot-box] booted persistent box', { userId, sandboxId: sandbox.sandboxId, taskType })
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

/** The live sandbox handle for a user's box (if any) — used by botRunner to attach task runs. */
export function getLiveUserBox(userId: string): { sandbox: Sandbox; sandboxId: string } | null {
  const s = liveBoxes.get(userId)
  return s ? { sandbox: s.sandbox, sandboxId: s.sandboxId } : null
}

/** Create (and remember) a per-task folder inside the user's box workspace. */
export async function createBoxTaskFolder(userId: string, taskId: string, goal: string): Promise<string> {
  const live = liveBoxes.get(userId)
  if (!live) return '/workspace'
  const dir = `/workspace/task-folders/${taskId.slice(0, 8)}`
  try {
    await live.sandbox.commands.run(
      `mkdir -p ${quote(dir)} && printf '%s\\n' ${quote(`# ${goal}\n# task ${taskId} — created ${new Date().toISOString()}`)} > ${quote(`${dir}/TASK.md`)}`,
      { timeoutMs: 20_000 },
    )
    return dir
  } catch {
    return '/workspace'
  }
}

/** Box health for the Computer tab. */
export async function getUserBoxStatus(userId: string): Promise<{ alive: boolean; sandboxId?: string; ageMinutes?: number }> {
  const live = liveBoxes.get(userId)
  if (!live) return { alive: false }
  try {
    await live.sandbox.commands.run('true', { timeoutMs: 5_000 })
    return { alive: true, sandboxId: live.sandboxId, ageMinutes: Math.max(0, Math.round((Date.now() - live.createdAt) / 60_000)) }
  } catch {
    liveBoxes.delete(userId)
    return { alive: false }
  }
}

/** Graceful shutdown (deploys / restarts). */
export async function killAllBoxes(): Promise<void> {
  for (const [, state] of liveBoxes) {
    try { await state.sandbox.kill() } catch { /* best effort */ }
  }
  liveBoxes.clear()
}
