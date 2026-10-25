/**
 * E2B Desktop wrapper — the dedicated per-run cloud computer ("bot computer"
 * Level B). One desktop VM per computer-enabled task: the agent drives it
 * through computer_* tools, the operator watches it live over noVNC and can
 * seize control (full takeover) at any time.
 *
 * The interface is deliberately tiny and injectable so the session state
 * machine (takeover guard, TTL, metering) is unit-testable without an E2B
 * account; the real implementation is a thin pass-through to @e2b/desktop.
 */

export interface DesktopStreamInfo {
  sandboxId: string
  streamAuthKey: string
  /** Watch-only noVNC URL (embedded in the admin UI by default). */
  viewUrl: string
  /** Interactive noVNC URL — handed out only while takeover is active. */
  interactiveUrl: string
}

export interface DesktopClient {
  readonly sandboxId: string
  startStream(): Promise<DesktopStreamInfo>
  screenshot(): Promise<Buffer>
  click(x: number, y: number, button: 'left' | 'right' | 'middle' | 'double'): Promise<void>
  moveMouse(x: number, y: number): Promise<void>
  scroll(direction: 'up' | 'down', amount: number): Promise<void>
  drag(from: [number, number], to: [number, number]): Promise<void>
  typeText(text: string): Promise<void>
  press(keys: string | string[]): Promise<void>
  launch(application: string): Promise<void>
  wait(ms: number): Promise<void>
  /** One shell command inside the VM (boot tasks: blanking off, xdpyinfo). */
  runCommand(command: string): Promise<{ stdout: string; stderr: string; exitCode: number | null }>
  kill(): Promise<void>
}

export class E2BDesktopError extends Error {
  constructor(message: string, public readonly code: 'auth' | 'unavailable' | 'api') { super(message) }
}

export function e2bApiKey(): string {
  const key = process.env.E2B_API_KEY
  if (!key) throw new E2BDesktopError('E2B_API_KEY is required for dedicated computer sessions', 'auth')
  return key
}

/** Cheap config probe for the enqueue gate: is a dedicated-computer provider
 *  configured at all? Lets the API refuse computer tasks up front instead of
 *  letting them dead-letter after pointless retries. */
export function isE2BConfigured(): boolean {
  return !!process.env.E2B_API_KEY
}

/** Build the noVNC URLs from parts — SAME-ORIGIN paths against the app:
 *  the vendored noVNC client (/novnc/vnc.html) talks to our backend's
 *  websockify proxy (/api/bot/novnc/<sandboxId>/websockify), which pipes to
 *  the sandbox's E2B ingress. The stream never leaves our origin, so the app
 *  CSP (default-src 'self', no frame-src) no longer blocks it — the old
 *  cross-origin iframes rendered "This content is blocked". The stream auth
 *  key rides the URL as the RFB password, same as before. */
export function buildVncUrls(sandboxId: string, streamAuthKey: string): { viewUrl: string; interactiveUrl: string } {
  const hostParam = process.env.NOVNC_HOST ? `&host=${encodeURIComponent(process.env.NOVNC_HOST)}` : ''
  const base = `/novnc/vnc.html?autoconnect=true&resize=scale${hostParam}&path=${encodeURIComponent(`/api/bot/novnc/${sandboxId}/websockify`)}&password=${encodeURIComponent(streamAuthKey)}`
  return {
    viewUrl: `${base}&view_only=true`,
    interactiveUrl: `${base}&view_only=false`,
  }
}

/** True when stream.start() rejected because the stream is already up on the
 *  sandbox (resume / second attach / second process). */
function isStreamAlreadyRunning(error: unknown): boolean {
  const msg = String((error as any)?.message || error || '')
  return /already running/i.test(msg)
}

/** Provider cap for this E2B tier (same 1h ceiling as the persistent box). */
const DESKTOP_TIMEOUT_CAP_MS = 60 * 60 * 1000
/** GNOME setup often outlives a shorter sandbox. Create/connect use at least this. */
const MIN_BOOT_TIMEOUT_MS = 10 * 60 * 1000
/** A new desktop is not created when the caller has less budget than this. */
const BOOT_QUOTA_FLOOR_MS = 5 * 60 * 1000
const DESKTOP_BOOT_RETRY_MESSAGE = 'The desktop did not finish starting. Try again.'

/** SDK error when the sandbox dies while create/connect still has a stream open. */
function isSandboxStreamTimeout(error: unknown): boolean {
  const msg = String((error as any)?.message || error || '')
  return /ended before the stream completed/i.test(msg) || /sandbox timeout/i.test(msg)
}

function logCreateStreamDeath(error: unknown): void {
  console.warn('[e2b-desktop] desktop stream ended before boot finished', {
    error: String((error as any)?.message || error),
  })
}

function rethrowCreateFailure(error: any): never {
  const status = error?.status ?? error?.response?.status
  if (status === 401 || status === 403) throw new E2BDesktopError(`E2B auth rejected (${status})`, 'auth')
  throw new E2BDesktopError(`E2B sandbox creation failed${status ? ` (${status})` : ''}`, status && status >= 500 ? 'unavailable' : 'api')
}

/** Real E2B implementation. Dynamic import keeps the SDK out of unit-test
 *  processes and lets the backend boot without the package configured. */
export async function createDesktop(opts: {
  timeoutMs: number
  /** Tag the VM so the reaper can find dedicated sandboxes that lost their DB row. */
  metadata?: Record<string, string>
  /** First attempt pauses on idle timeout. The stream-death retry omits it. */
  pauseOnTimeout?: boolean
}): Promise<DesktopClient> {
  e2bApiKey()
  if (!(typeof opts.timeoutMs === 'number' && Number.isFinite(opts.timeoutMs) && opts.timeoutMs >= BOOT_QUOTA_FLOOR_MS)) {
    const { AgentTaskError } = await import('./agentTasks')
    throw new AgentTaskError('quota')
  }
  const bootMs = Math.min(DESKTOP_TIMEOUT_CAP_MS, Math.max(MIN_BOOT_TIMEOUT_MS, opts.timeoutMs))
  const budgetMs = Math.min(DESKTOP_TIMEOUT_CAP_MS, opts.timeoutMs)
  const { awaitGnomeDesktop, desktopTemplateId, seedDesktopLaunchers } = await import('./gnomeSession')
  const template = desktopTemplateId()
  if (!template) {
    throw new E2BDesktopError(
      'E2B_DESKTOP_TEMPLATE is required for dedicated computer sessions (GNOME image). Build infra/e2b-gnome-desktop and set the template id.',
      'unavailable',
    )
  }
  let Sandbox: any
  try {
    const mod = await import('@e2b/desktop')
    Sandbox = mod.Sandbox
  } catch {
    throw new E2BDesktopError('@e2b/desktop is not installed', 'unavailable')
  }
  const pauseFirst = opts.pauseOnTimeout !== false
  const createOnce = (pauseOnTimeout: boolean) => {
    const options: Record<string, unknown> = {
      timeoutMs: bootMs,
      metadata: { loopGpt: 'bot-desktop', ...(opts.metadata || {}) },
    }
    // Pause-on-timeout is the first attempt. Some accounts end the create
    // stream when that lifecycle is rejected, so the single retry omits it.
    if (pauseOnTimeout) options.lifecycle = { onTimeout: 'pause', autoResume: true }
    return Sandbox.create(template, options)
  }
  let retried = !pauseFirst
  const createOrRetry = async (error: unknown, desktopToKill?: any): Promise<any> => {
    if (desktopToKill) await desktopToKill.kill().catch(() => undefined)
    if (!isSandboxStreamTimeout(error)) {
      if (desktopToKill) {
        const msg = String((error as Error)?.message || error)
        throw new E2BDesktopError(msg, 'unavailable')
      }
      rethrowCreateFailure(error)
    }
    logCreateStreamDeath(error)
    if (retried) throw new E2BDesktopError(DESKTOP_BOOT_RETRY_MESSAGE, 'unavailable')
    retried = true
    try {
      return await createOnce(false)
    } catch (second) {
      if (isSandboxStreamTimeout(second)) {
        logCreateStreamDeath(second)
        throw new E2BDesktopError(DESKTOP_BOOT_RETRY_MESSAGE, 'unavailable')
      }
      rethrowCreateFailure(second)
    }
  }

  let desktop: any
  try {
    // Template must be the first argument (same as bot-live-smoke / SDK docs).
    desktop = await createOnce(pauseFirst)
  } catch (error) {
    desktop = await createOrRetry(error)
  }

  // Same GNOME-first gate as the persistent box — never hand back XFCE.
  try {
    await awaitGnomeDesktop(desktop)
    await seedDesktopLaunchers(desktop)
  } catch (error) {
    try {
      desktop = await createOrRetry(error, desktop)
      await awaitGnomeDesktop(desktop)
      await seedDesktopLaunchers(desktop)
    } catch (second) {
      await desktop.kill().catch(() => undefined)
      if (second instanceof E2BDesktopError) throw second
      if (isSandboxStreamTimeout(second)) {
        logCreateStreamDeath(second)
        throw new E2BDesktopError(DESKTOP_BOOT_RETRY_MESSAGE, 'unavailable')
      }
      throw new E2BDesktopError(String((second as Error)?.message || second), 'unavailable')
    }
  }

  return wrapDesktop(desktop, true, undefined, budgetMs)
}

export interface PersistedStreamCreds {
  streamAuthKey?: string | null
  /** Real remaining VM budget in ms. Connect uses at least 10 minutes so the
   *  stream can finish; startStream then shrinks the sandbox back to this. */
  timeoutMs?: number
}

/** Wrap an already-running desktop sandbox (the persistent box) as a
 *  DesktopClient. When `owned` is false, kill() is a detach — the box stays
 *  alive for the next task and the operator's Computer tab.
 *
 *  `persisted` carries stream credentials written when the stream was first
 *  started: a fresh Sandbox.connect never owned the stream, so getAuthKey()
 *  fails after "already running" — the persisted key is the only recovery. */
function wrapDesktop(desktop: any, owned: boolean, persisted?: PersistedStreamCreds, settleTimeoutMs?: number): DesktopClient {
  const client: DesktopClient = {
    sandboxId: String(desktop.sandboxId),
    async startStream() {
      try {
        await desktop.stream.start({ requireAuth: true })
      } catch (error) {
        // Resume path: the stream survives on the sandbox across SDK
        // reconnects, so a second start() rejects with "already running".
        // Fall through and prefer this instance's auth key; if it never owned
        // the stream, use the credentials persisted on BotBox / BotRun.
        if (!isStreamAlreadyRunning(error)) throw error
      }
      if (settleTimeoutMs != null) {
        try {
          await desktop.setTimeout(settleTimeoutMs)
        } catch (error) {
          console.warn('[e2b-desktop] could not shrink sandbox timeout to the remaining budget', String((error as any)?.message || error))
        }
      }
      let authKey = ''
      try {
        authKey = String(desktop.stream.getAuthKey() || '')
      } catch {
        authKey = ''
      }
      if (!authKey) authKey = String(persisted?.streamAuthKey || '')
      if (!authKey) {
        throw new E2BDesktopError(
          'Desktop stream is already running but no stream auth key is available (persisted credentials missing)',
          'api',
        )
      }
      // Same-origin noVNC URLs (our /novnc client + backend websockify proxy),
      // never the E2B-hosted vnc.html — see buildVncUrls for why.
      const urls = buildVncUrls(client.sandboxId, authKey)
      return {
        sandboxId: client.sandboxId,
        streamAuthKey: authKey,
        viewUrl: urls.viewUrl,
        interactiveUrl: urls.interactiveUrl,
      }
    },
    async screenshot() {
      const bytes: Uint8Array = await desktop.screenshot('bytes')
      return Buffer.from(bytes)
    },
    async click(x, y, button) {
      if (button === 'left') await desktop.leftClick(x, y)
      else if (button === 'right') await desktop.rightClick(x, y)
      else if (button === 'middle') await desktop.middleClick(x, y)
      else await desktop.doubleClick(x, y)
    },
    async moveMouse(x, y) { await desktop.moveMouse(x, y) },
    async scroll(direction, amount) { await desktop.scroll(direction, amount) },
    async drag(from, to) { await desktop.drag(from, to) },
    async typeText(text) { await desktop.write(text) },
    async press(keys) { await desktop.press(keys) },
    async launch(application) { await desktop.launch(application) },
    async wait(ms) { await desktop.wait(ms) },
    async runCommand(command) {
      const result = await desktop.commands.run(command)
      return { stdout: result.stdout || '', stderr: result.stderr || '', exitCode: result.exitCode ?? null }
    },
    async kill() {
      if (!owned) return // detach — the persistent box outlives the session
      await desktop.kill()
    },
  }
  return client
}

export { wrapDesktop }

/** Attach to a RUNNING desktop sandbox by id (the user's persistent box).
 *  Returns a client whose kill() detaches instead of terminating.
 *  Pass persisted stream credentials from BotBox so startStream() works when
 *  the stream is already up on a sandbox this SDK instance never owned. */
export async function attachDesktop(sandboxId: string, persisted?: PersistedStreamCreds): Promise<DesktopClient> {
  e2bApiKey()
  let Sandbox: any
  try {
    const mod = await import('@e2b/desktop')
    Sandbox = mod.Sandbox
  } catch {
    throw new E2BDesktopError('@e2b/desktop is not installed', 'unavailable')
  }
  const budgetMs = persisted?.timeoutMs
  // Connect always gets at least 10 minutes and never more than the 1 hour
  // cap. The caller's budget (the shared box lease, or a dedicated TTL) is
  // applied with setTimeout only after the stream is up.
  const connectMs = budgetMs == null || !Number.isFinite(budgetMs)
    ? MIN_BOOT_TIMEOUT_MS
    : Math.min(DESKTOP_TIMEOUT_CAP_MS, Math.max(MIN_BOOT_TIMEOUT_MS, budgetMs))
  const desktop = await Sandbox.connect(sandboxId, { timeoutMs: connectMs })
  const settleMs = budgetMs == null || !Number.isFinite(budgetMs) || budgetMs <= 0
    ? undefined
    : Math.min(DESKTOP_TIMEOUT_CAP_MS, budgetMs)
  return wrapDesktop(desktop, false, persisted, settleMs)
}
