/**
 * One dedicated-computer session for a bot run (E2B Desktop). Owns the
 * desktop client, the noVNC stream info, the takeover state machine, and
 * screenshot→artifact capture.
 *
 * Takeover is cross-process: the admin API flips BotRun.takeoverRequested in
 * Postgres; this controller polls it between actions. While a human drives,
 * the agent pauses — the task lease keeps renewing on the worker's heartbeat,
 * so the run never looks abandoned. Release (or the takeover timeout) resumes
 * the loop from a fresh screenshot.
 */
import type { AgentEvent } from '../agent/types'
import { saveArtifact } from '../agent/artifacts'
import { createDesktop, type DesktopClient, type DesktopStreamInfo } from './e2bDesktop'

export class ComputerTakeoverTimeout extends Error {
  constructor() { super('Operator takeover did not end within the allowed window') }
}

/** Fallback display geometry when xdpyinfo is unavailable at boot. */
export const COMPUTER_FALLBACK_SCREEN = { width: 1024, height: 768 }

export interface ComputerSessionOptions {
  runId: string
  userId: string
  conversationId: string
  ttlMinutes: number
  /** Max pause per takeover before the task fails (default 10 min). */
  takeoverTimeoutMs?: number
  emit: (event: AgentEvent) => void
  /** DB-backed takeover flag poll (cross-process). */
  isTakeoverRequested: (runId: string) => Promise<boolean>
  /** Injectable desktop factory (tests). */
  createDesktopFn?: (opts: { timeoutMs: number }) => Promise<DesktopClient>
  /** Attach the session to the caller's PERSISTENT box instead of creating a
   *  fresh VM: the run shares the always-on computer (Grok parity), and close()
   *  leaves the box alive. */
  existingDesktop?: DesktopClient
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

export class ComputerSession {
  /** True display geometry, read from the VM at boot (xdpyinfo) — the
   *  coordinate tools clamp against this instead of a static env guess. */
  readonly screen: { width: number; height: number }

  private constructor(
    private readonly client: DesktopClient,
    readonly info: DesktopStreamInfo,
    private readonly opts: ComputerSessionOptions,
    private readonly startedAt: number,
    screen: { width: number; height: number },
    private screenshots = 0,
    private endedAt?: number,
    private readonly ownsDesktop = true,
  ) {
    this.screen = screen
  }

  /** Parse "dimensions: 1024x768 pixels" style xdpyinfo output. */
  static parseScreenDimensions(stdout: string): { width: number; height: number } {
    const match = /dimensions:\s*(\d+)x(\d+)/i.exec(stdout)
    if (!match) return { width: COMPUTER_FALLBACK_SCREEN.width, height: COMPUTER_FALLBACK_SCREEN.height }
    const width = Number(match[1])
    const height = Number(match[2])
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 320 || height < 240) {
      return { width: COMPUTER_FALLBACK_SCREEN.width, height: COMPUTER_FALLBACK_SCREEN.height }
    }
    return { width, height }
  }

  static async start(opts: ComputerSessionOptions): Promise<ComputerSession> {
    const create = opts.createDesktopFn || createDesktop
    const now = opts.now || (() => Date.now())
    const ownsDesktop = !opts.existingDesktop
    const client = opts.existingDesktop || (await create({ timeoutMs: opts.ttlMinutes * 60_000 }))
    try {
      opts.emit({ type: 'status', message: ownsDesktop ? 'Dedicated computer booted; starting the live stream…' : 'Attached to your persistent bot computer; starting the live stream…' })
      const info = await client.startStream()
      opts.emit({ type: 'status', message: 'Live stream up; preparing the desktop (screen wake + Chrome)…' })
      // Wake discipline: an idle desktop blanks into a black screen that reads
      // as a failure — disable the screensaver and DPMS power management, then
      // open Chrome so the session starts on a meaningful workspace (Grok-style
      // boot). X client commands need DISPLAY set (the E2B desktop runs X on
      // :0); `xset -dpms` takes NO numeric arguments — the previous
      // `xset -dpms 0 0` was malformed and silently no-oped, and failures were
      // swallowed, which is exactly how deployments shipped black streams.
      const wake = await client.runCommand('DISPLAY=:0 xset s off; DISPLAY=:0 xset s noblank; DISPLAY=:0 xset -dpms')
        .catch((err) => ({ stdout: '', stderr: String(err), exitCode: 1 }))
      if (wake.exitCode) {
        opts.emit({ type: 'status', message: 'Screen wake command failed — the desktop may blank to black; continuing.' })
      }
      try {
        await client.launch('google-chrome')
      } catch {
        opts.emit({ type: 'status', message: 'Chrome is not available in this image; continuing without it.' })
      }
      const probe = await client.runCommand('DISPLAY=:0 xdpyinfo | grep -i dimensions').catch(() => ({ stdout: '', stderr: '', exitCode: 1 }))
      const screen = ComputerSession.parseScreenDimensions(probe.stdout)
      opts.emit({ type: 'status', message: `Desktop ready (${screen.width}x${screen.height}) — the agent is taking over.` })
      return new ComputerSession(client, info, opts, now(), screen, 0, undefined, ownsDesktop)
    } catch (error) {
      if (ownsDesktop) await client.kill().catch(() => { /* best effort */ })
      throw error
    }
  }

  /** Capture the screen WITHOUT persisting or emitting (teach-mode recording
   *  buffer); the runner decides which frames become artifacts or model parts. */
  async captureSilent(): Promise<Buffer> {
    return this.client.screenshot()
  }

  /** Whole-minutes metered for the run record (rounded up). */
  minutes(): number {
    const end = this.endedAt ?? (this.opts.now || (() => Date.now()))()
    return Math.max(1, Math.ceil((end - this.startedAt) / 60_000))
  }

  /** Pause while the operator drives the VM. Resolves on release; throws
   *  ComputerTakeoverTimeout past the window. No-op when no takeover is active. */
  async guard(): Promise<void> {
    const sleep = this.opts.sleep || ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)))
    const timeoutMs = this.opts.takeoverTimeoutMs ?? 10 * 60_000
    let waited = 0
    let announced = false
    while (true) {
      let takeover = false
      try { takeover = await this.opts.isTakeoverRequested(this.opts.runId) } catch { /* transient DB errors: keep driving */ }
      if (!takeover) {
        if (announced) this.opts.emit({ type: 'status', message: 'Operator released the computer; resuming from a fresh screenshot…' })
        return
      }
      if (!announced) {
        announced = true
        this.opts.emit({ type: 'status', message: 'Operator takeover: a human is driving the computer; the bot is paused…' })
      }
      if (waited >= timeoutMs) throw new ComputerTakeoverTimeout()
      await sleep(2000)
      waited += 2000
    }
  }

  /** Capture the screen, persist it as an artifact, and return a data URI the
   *  runtime injects into the next model turn. */
  async screenshot(label?: string): Promise<{ artifact: any; imageDataUri: string }> {
    const png = await this.client.screenshot()
    this.screenshots += 1
    const name = `computer-${String(this.screenshots).padStart(3, '0')}${label ? `-${label}` : ''}.png`
    const artifact = await saveArtifact(name, png, { userId: this.opts.userId, conversationId: this.opts.conversationId })
    this.opts.emit({ type: 'artifact', artifact })
    return { artifact, imageDataUri: `data:image/png;base64,${png.toString('base64')}` }
  }

  /** One observe→act→observe beat: takeover guard, action, short settle, screenshot. */
  async act(description: string, fn: (client: DesktopClient) => Promise<void>): Promise<{ artifact: any; imageDataUri: string }> {
    await this.guard()
    await fn(this.client)
    await this.client.wait(400)
    return this.screenshot()
  }

  async close(): Promise<void> {
    if (this.endedAt) return
    this.endedAt = (this.opts.now || (() => Date.now()))()
    // A session on the persistent box DETACHES instead of killing — the box
    // stays on for the next task and for the operator's Computer tab.
    if (!this.ownsDesktop) return
    await this.client.kill().catch(() => { /* TTL on E2B's side is the backstop */ })
  }
}
