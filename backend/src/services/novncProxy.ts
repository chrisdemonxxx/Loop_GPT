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
 * Auth: the httpOnly session cookie (or a Bearer token). The sandbox must be
 * the caller's persistent box, belong to one of their recent runs, or the
 * caller must be an admin — the RFB password still applies inside the pipe.
 */
import type { IncomingMessage } from 'http'
import type { Duplex } from 'stream'
import type { Server as HttpServer } from 'http'
import jwt from 'jsonwebtoken'
import { WebSocket, WebSocketServer } from 'ws'
import { jwtSecret } from './jwtSecret'
import { readSessionCookie } from './auth'
import { prisma } from './prisma'

const PATH = /^\/api\/bot\/novnc\/([A-Za-z0-9]+)\/websockify\/?$/

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

function authenticate(req: IncomingMessage): string | null {
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

/** Attach the websockify proxy to the HTTP server's upgrade event. Other
 *  upgrade paths are left untouched (destroyed by the default handler). */
export function attachNovncProxy(server: HttpServer): void {
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false })

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const sandboxId = novncSandboxId(req.url)
    if (!sandboxId) return // not ours — Node's default upgrade path handles it
    void (async () => {
      try {
        const userId = authenticate(req)
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

function pipeToE2B(client: WebSocket, sandboxId: string): void {
  const pending: Buffer[] = []
  let open = false
  const upstream = new WebSocket(upstreamUrl(sandboxId), ['binary'], {
    perMessageDeflate: false,
    handshakeTimeout: 15_000,
  })

  const flush = () => {
    while (open && pending.length) upstream.send(pending.shift()!)
  }
  const closeBoth = (code = 1000) => {
    open = false
    try { if (client.readyState === WebSocket.OPEN) client.close(code) } catch { /* already gone */ }
    try { if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) upstream.close(code) } catch { /* already gone */ }
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
    // noVNC's RFB traffic is binary; buffer until the upstream is writable.
    pending.push(data)
    flush()
  })
  client.on('close', () => closeBoth())
  client.on('error', () => closeBoth(1011))

  // Idle VMs stream little; a dead peer must not pin the upstream forever.
  const heartbeat = setInterval(() => {
    if (client.readyState === WebSocket.OPEN) client.ping()
  }, 30_000)
  client.on('close', () => clearInterval(heartbeat))
  upstream.on('close', () => clearInterval(heartbeat))
}
