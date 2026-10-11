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

/** Build the managed noVNC URLs from parts. The @e2b/desktop SDK constructs
 *  exactly this shape (vnc.html on the sandbox's 6080 ingress with the stream
 *  auth key as the `password` query param) — but only on the SDK instance that
 *  STARTED the stream, because the auth key and URL builder live in instance-
 *  local state. After a `Sandbox.connect` (backend restart, second process)
 *  that state is gone, so callers persist sandboxId + authKey at stream start
 *  and rebuild the URLs here. */
export function buildVncUrls(sandboxId: string, streamAuthKey: string): { viewUrl: string; interactiveUrl: string } {
  const domain = process.env.E2B_DOMAIN || 'e2b.app'
  const base = `https://6080-${sandboxId}.${domain}/vnc.html?autoconnect=true&resize=scale&password=${encodeURIComponent(streamAuthKey)}`
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

/** Real E2B implementation. Dynamic import keeps the SDK out of unit-test
 *  processes and lets the backend boot without the package configured. */
export async function createDesktop(opts: { timeoutMs: number }): Promise<DesktopClient> {
  e2bApiKey()
  let Sandbox: any
  try {
    const mod = await import('@e2b/desktop')
    Sandbox = mod.Sandbox
  } catch {
    throw new E2BDesktopError('@e2b/desktop is not installed', 'unavailable')
  }
  let desktop: any
  try {
    desktop = await Sandbox.create({ timeoutMs: opts.timeoutMs })
  } catch (error: any) {
    const status = error?.status ?? error?.response?.status
    if (status === 401 || status === 403) throw new E2BDesktopError(`E2B auth rejected (${status})`, 'auth')
    throw new E2BDesktopError(`E2B sandbox creation failed${status ? ` (${status})` : ''}`, status && status >= 500 ? 'unavailable' : 'api')
  }

  return wrapDesktop(desktop, false)
}

/** Wrap an already-running desktop sandbox (the persistent box) as a
 *  DesktopClient. When `owned` is false, kill() is a detach — the box stays
 *  alive for the next task and the operator's Computer tab. */
function wrapDesktop(desktop: any, owned: boolean): DesktopClient {
  const client: DesktopClient = {
    sandboxId: String(desktop.sandboxId),
    async startStream() {
      try {
        await desktop.stream.start({ requireAuth: true })
      } catch (error) {
        // Resume path: the stream survives on the sandbox across SDK
        // reconnects, so a second start() rejects with "already running".
        // That's fine — fall through and read the auth key; if this SDK
        // instance never owned the stream (fresh Sandbox.connect), the reads
        // throw and the caller falls back to its persisted credentials.
        if (!isStreamAlreadyRunning(error)) throw error
      }
      const authKey = desktop.stream.getAuthKey()
      return {
        sandboxId: client.sandboxId,
        streamAuthKey: authKey,
        viewUrl: desktop.stream.getUrl({ viewOnly: true, authKey }),
        interactiveUrl: desktop.stream.getUrl({ viewOnly: false, authKey }),
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

/** Attach to a RUNNING desktop sandbox by id (the user's persistent box).
 *  Returns a client whose kill() detaches instead of terminating. */
export async function attachDesktop(sandboxId: string): Promise<DesktopClient> {
  e2bApiKey()
  let Sandbox: any
  try {
    const mod = await import('@e2b/desktop')
    Sandbox = mod.Sandbox
  } catch {
    throw new E2BDesktopError('@e2b/desktop is not installed', 'unavailable')
  }
  const desktop = await Sandbox.connect(sandboxId)
  return wrapDesktop(desktop, false)
}
