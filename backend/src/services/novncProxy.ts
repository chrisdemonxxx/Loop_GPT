/**
 * Self-hosted noVNC data plane (Grok-style): the bot computer streams through
 * OUR origin instead of iframing E2B's vnc.html on a third-party host.
 *
 * Why: the app's own CSP (default-src 'self', no frame-src) blocks every
 * cross-origin iframe — Chrome rendered "This content is blocked" and Firefox
 * its XFO error page, so the live screen was unreachable even when the VM was
 * perfectly healthy. Proxying the websockify socket through the backend makes
 * the stream same-origin end to end: no frame-src exceptions, no third-party
 * cookies, no corporate-proxy surprises, and the auth key stays a server-side
 * RFB secret instead of a ticket to a foreign origin.
 *
 * Path: /api/bot/novnc/<sandboxId>/websockify — the vendored noVNC client
 * (apps/web/public/novnc) builds wss://<our-host><this path>.
 *
 * Auth: the httpOnly session cookie, a Bearer token, or a short-lived signed
 * query token (`?token=`) for the desktop app's Bearer sessions (WebSocket
 * cannot set Authorization from some clients).
 *
 * View-only is enforced server-side: RFB KeyEvent / PointerEvent / ClientCutText
 * are dropped unless an active takeover is recorded for this sandbox.
 */
import type { IncomingMessage } from 'http'
import type { Duplex } from 'stream'
import type { Server as HttpServer } from 'http'
import jwt from 'jsonwebtoken'
import { WebSocket, WebSocketServer } from 'ws'
import { jwtSecret } from './jwtSecret'
import { readSessionCookie } from './auth'
import { prisma } from './prisma'
import { createCorsOriginPolicy } from '../middleware/corsPolicy'

const PATH = /^\/api\/bot\/novnc\/([A-Za-z0-9]+)\/websockify\/?$/
const MAX_PENDING_BYTES = 256 * 1024
const WS_TOKEN_TTL_SEC = 60
/** RFB client→server message types that constitute input (not view traffic). */
const RFB_INPUT_TYPES = new Set([4, 5, 6]) // KeyEvent, PointerEvent, ClientCutText

export function novncSandboxId(url: string | undefined): string | null {
  if (!url) return null
  const match = PATH.exec(url.split('?')[0])
  return match ? match[1] : null
}

function upstreamUrl(sandboxId: string): string {
  const domain = process.env.E2B_DOMAIN || 'e2b.app'
  if (!/^[A-Za-z0-9]+$/.test(sandboxId)) throw new Error('invalid sandbox id')
  return `wss://6080-${sandboxId}.${domain}/websockify`
}

function queryToken(url: string | undefined): string | null {
  if (!url) return null
  const q = url.includes('?') ? url.slice(url.indexOf('?') + 1) : ''
  const params = new URLSearchParams(q)
  const token = params.get('token')
  return token && token.length > 0 && token.length <= 4096 ? token : null
}

/** Mint a short-lived signed token for websocket auth (desktop Bearer sessions). */
export function mintNovncWsToken(userId: string, sandboxId: string, ttlSec = WS_TOKEN_TTL_SEC): { token: string; expiresIn: number } {
  if (!/^[A-Za-z0-9]+$/.test(sandboxId)) throw new Error('invalid sandbox id')
  const expiresIn = Math.max(15, Math.min(ttlSec, 300))
  const token = jwt.sign(
    { userId, sandboxId, purpose: 'novnc-ws' },
    jwtSecret(),
    { algorithm: 'HS256', expiresIn },
  )
  return { token, expiresIn }
}

function verifyNovncWsToken(token: string, sandboxId: string): string | null {
  try {
    const decoded = jwt.verify(token, jwtSecret(), { algorithms: ['HS256'] }) as {
      userId?: unknown
      sandboxId?: unknown
      purpose?: unknown
    }
    if (decoded.purpose !== 'novnc-ws') return null
    if (decoded.sandboxId !== sandboxId) return null
    const userId = decoded.userId
    return typeof userId === 'string' && userId.length > 0 && userId.length <= 128 ? userId : null
  } catch {
    return null
  }
}

/** The caller may drive this sandbox: it is their persistent box, or the
 *  computer of one of their recent runs, or they are an admin. */
async function authorize(userId: string, sandboxId: string): Promise<boolean> {
  if (!prisma) return false
  try {
    const box = await prisma.botBox.findUnique({ where: { userId }, select: { sandboxId: true } })
    if (box?.sandboxId === sandboxId) return true
    const runs = await prisma.botRun.findMany({
      where: { task: { userId } },
      orderBy: { startedAt: 'desc' },
      take: 10,
      select: { computer: true },
    })
    if (runs.some((run) => (run.computer as { sandboxId?: string } | null)?.sandboxId === sandboxId)) return true
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { role: true } })
    return user?.role === 'admin'
  } catch {
    return false
  }
}

/** True when any running BotRun for this sandbox has takeover requested. */
async function isTakeoverActive(sandboxId: string): Promise<boolean> {
  if (!prisma) return false
  try {
    const runs = await prisma.botRun.findMany({
      where: { status: 'running', takeoverRequested: true },
      orderBy: { startedAt: 'desc' },
      take: 20,
      select: { computer: true },
    })
    return runs.some((run) => (run.computer as { sandboxId?: string } | null)?.sandboxId === sandboxId)
  } catch {
    return false
  }
}

function authenticate(req: IncomingMessage, sandboxId: string): string | null {
  const qsToken = queryToken(req.url)
  if (qsToken) {
    const fromQs = verifyNovncWsToken(qsToken, sandboxId)
    if (fromQs) return fromQs
  }
  const bearer = /^Bearer ([^\s]+)$/i.exec(String(req.headers.authorization || ''))?.[1]
  const token = bearer || readSessionCookie(req as Parameters<typeof readSessionCookie>[0])
  if (!token) return null
  try {
    const decoded = jwt.verify(token, jwtSecret(), { algorithms: ['HS256'] })
    const userId = (decoded as { userId?: unknown }).userId
    return typeof userId === 'string' && userId.length > 0 && userId.length <= 128 ? userId : null
  } catch {
    return null
  }
}

function originAllowed(req: IncomingMessage): boolean {
  const origin = req.headers.origin
  if (origin === undefined) return true // non-browser / desktop clients
  const policy = createCorsOriginPolicy(process.env.FRONTEND_URL || 'http://localhost:3000')
  if (policy(origin)) return true
  // Same-host pages (API origin serving /novnc) are also fine.
  try {
    const host = req.headers.host
    if (!host) return false
    const proto = (req.headers['x-forwarded-proto'] as string) || 'http'
    return new URL(origin).origin === new URL(`${proto}://${host}`).origin
  } catch {
    return false
  }
}

/** Attach the websockify proxy to the HTTP server's upgrade event. Other
 *  upgrade paths are left untouched (destroyed by the default handler). */
export function attachNovncProxy(server: HttpServer): void {
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false })

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const sandboxId = novncSandboxId(req.url)
    if (!sandboxId) return // not ours — Node's default upgrade path handles it
    void (async () => {
      try {
        if (!originAllowed(req)) throw new Error('forbidden')
        const userId = authenticate(req, sandboxId)
        if (!userId) throw new Error('unauthorized')
        if (!(await authorize(userId, sandboxId))) throw new Error('forbidden')
        wss.handleUpgrade(req, socket, head, (client) => pipeToE2B(client, sandboxId))
      } catch (error: any) {
        const status = error?.message === 'forbidden' ? '403 Forbidden' : '401 Unauthorized'
        socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`)
        socket.destroy()
      }
    })()
  })
}

function rfbClientMessageType(data: Buffer): number | null {
  if (!data || data.length < 1) return null
  return data[0]
}

function pipeToE2B(client: WebSocket, sandboxId: string): void {
  const pending: Buffer[] = []
  let pendingBytes = 0
  let open = false
  let takeover = false
  let takeoverCheckedAt = 0
  const upstream = new WebSocket(upstreamUrl(sandboxId), ['binary'], {
    perMessageDeflate: false,
    handshakeTimeout: 15_000,
  })

  const flush = () => {
    while (open && pending.length) {
      const chunk = pending.shift()!
      pendingBytes -= chunk.length
      upstream.send(chunk)
    }
  }
  const closeBoth = (code = 1000) => {
    open = false
    try { if (client.readyState === WebSocket.OPEN) client.close(code) } catch { /* already gone */ }
    try { if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) upstream.close(code) } catch { /* already gone */ }
  }

  const refreshTakeover = async () => {
    const now = Date.now()
    if (now - takeoverCheckedAt < 1000) return
    takeoverCheckedAt = now
    takeover = await isTakeoverActive(sandboxId)
  }

  upstream.on('open', () => { open = true; flush() })
  upstream.on('message', (data: Buffer, isBinary: boolean) => {
    if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary })
  })
  upstream.on('close', () => closeBoth())
  upstream.on('error', (error) => {
    console.warn(`[novnc] upstream error for ${sandboxId}:`, error.message)
    closeBoth(1011)
  })

  client.on('message', (data: Buffer) => {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer)
    const msgType = rfbClientMessageType(buf)
    if (msgType != null && RFB_INPUT_TYPES.has(msgType) && !takeover) {
      // Drop input unless takeover is active (server-side view-only).
      void refreshTakeover()
      return
    }
    if (pendingBytes + buf.length > MAX_PENDING_BYTES) {
      console.warn(`[novnc] pre-open buffer cap exceeded for ${sandboxId}`)
      closeBoth(1009)
      return
    }
    pending.push(buf)
    pendingBytes += buf.length
    flush()
  })
  client.on('close', () => closeBoth())
  client.on('error', () => closeBoth(1011))

  void refreshTakeover()
  const takeoverPoll = setInterval(() => { void refreshTakeover() }, 2000)
  takeoverPoll.unref?.()

  // Idle VMs stream little; a dead peer must not pin the upstream forever.
  const heartbeat = setInterval(() => {
    if (client.readyState === WebSocket.OPEN) client.ping()
  }, 30_000)
  client.on('close', () => { clearInterval(heartbeat); clearInterval(takeoverPoll) })
  upstream.on('close', () => { clearInterval(heartbeat); clearInterval(takeoverPoll) })
}
