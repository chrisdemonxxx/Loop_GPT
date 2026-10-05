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
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

export class ComputerSession {
  private constructor(
    private readonly client: DesktopClient,
    readonly info: DesktopStreamInfo,
    private readonly opts: ComputerSessionOptions,
    private readonly startedAt: number,
    private screenshots = 0,
    private endedAt?: number,
  ) {}

  static async start(opts: ComputerSessionOptions): Promise<ComputerSession> {
    const create = opts.createDesktopFn || createDesktop
    const now = opts.now || (() => Date.now())
    const client = await create({ timeoutMs: opts.ttlMinutes * 60_000 })
    try {
      const info = await client.startStream()
      return new ComputerSession(client, info, opts, now())
    } catch (error) {
      await client.kill().catch(() => { /* best effort */ })
      throw error
    }
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
    await this.client.kill().catch(() => { /* TTL on E2B's side is the backstop */ })
  }
}
