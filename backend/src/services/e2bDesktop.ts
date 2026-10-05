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

  const client: DesktopClient = {
    sandboxId: String(desktop.sandboxId),
    async startStream() {
      await desktop.stream.start({ requireAuth: true })
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
    async kill() { await desktop.kill() },
  }
  return client
}
