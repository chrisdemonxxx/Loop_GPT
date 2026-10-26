/**
 * Outbound device socket for the person's own browser.
 * The extension connects to GET /api/browser/pair. Chat, Build, and Loop Bot
 * name a device id; calls go only to that live socket.
 *
 * Persisted in Prisma (BrowserDevice & BrowserGrant tables) with an in-memory
 * fallback when hasDb is false in unit tests.
 */
import { createHash, randomBytes, timingSafeEqual } from 'crypto'
import type { IncomingMessage } from 'http'
import type { Duplex } from 'stream'
import type { Server as HttpServer } from 'http'
import { Prisma } from '@prisma/client'
import { WebSocket, WebSocketServer } from 'ws'
import { redactPayload } from './browserRedact'
import { prisma, hasDb } from './prisma'
import { configStore } from '../agent/configStore'
import { getUserOctoClient } from '../agent/connectors/octoConnector'
import {
  getUserCaptchaSettings,
  trySolveCaptchaForUser,
  type CaptchaChallenge,
} from './captchaSolver'
import {
  BROWSER_OFFLINE_MESSAGE,
  BROWSER_ONION_MESSAGE,
  BROWSER_RELEASED_MESSAGE,
  evaluateBrowserCall,
  shouldDetachAfterCall,
  type BrowserCallDecision,
} from '../agent/browserGrant'

export const BROWSER_PACKAGE_VERSION = '1.0.0'
export const CAPTCHA_HANDLING = 'wait' as const

export type BrowserFamily = 'chromium' | 'firefox' | 'tor' | 'octo'
export type BrowserRunSource = 'chat' | 'bot' | 'build'

export interface BrowserDevice {
  id: string
  userId: string
  name: string
  family: BrowserFamily
  browserName: string
  profileLabel: string
  packageVersion: string
  packageKind: BrowserFamily
  installId: string
  /** sha256 of the reconnect token. The raw token is only sent once, at pair. */
  tokenHash: string
  pairedAt: string
  lastSeenAt: string
  needsYou: { reason: string; at: string } | null
  octoLocalAvailable?: boolean
  octoUuid?: string
}

export interface PublicBrowserDevice {
  id: string
  name: string
  family: BrowserFamily
  browserName: string
  profileLabel: string
  packageVersion: string
  packageKind: BrowserFamily
  online: boolean
  needsYou: { reason: string; at: string } | null
  versionSkew: boolean
  lastSeenAt: string
  octoUuid?: string
}

interface ArmedRun {
  runId: string
  userId: string
  deviceId: string
  source: BrowserRunSource
  revoked: boolean
  closeTabs: boolean
  inflight: number
  ended: boolean
  startedOctoProfiles?: Set<string>
}

interface InMemoryGrant {
  id: string
  userId: string
  deviceId: string
  source: BrowserRunSource
  runId?: string
  used: boolean
  revoked: boolean
  expiresAt: Date
}

interface SocketState {
  socket: WebSocket
  deviceId: string
  pending: Map<string, { resolve: (value: Record<string, unknown>) => void; timer: ReturnType<typeof setTimeout> }>
}

const PAIR_TTL_MS = 10 * 60_000

function appOrigins(): string[] {
  const raw = [process.env.FRONTEND_URL || 'http://localhost:3000', 'http://localhost:3000', 'https://loop-gpt.cyou']
  const origins: string[] = []
  for (const value of raw) {
    try { origins.push(new URL(value).origin) } catch { /* skip */ }
  }
  return origins
}

const devices = new Map<string, BrowserDevice>()
const byInstall = new Map<string, string>()
const byToken = new Map<string, string>()
const sockets = new Map<string, SocketState>()
const pairCodes = new Map<string, { userId: string; expiresAt: number }>()
const runs = new Map<string, ArmedRun>()
const grants = new Map<string, InMemoryGrant>()

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export function resetBrowserBridgeForTests() {
  devices.clear()
  byInstall.clear()
  byToken.clear()
  for (const state of sockets.values()) {
    try { state.socket.close() } catch { /* gone */ }
  }
  sockets.clear()
  pairCodes.clear()
  runs.clear()
  grants.clear()
}

function familyOf(value: unknown): BrowserFamily {
  if (value === 'firefox' || value === 'tor' || value === 'octo') return value
  return 'chromium'
}

export function versionSkew(installed: string | null | undefined): boolean {
  return !installed || installed !== BROWSER_PACKAGE_VERSION
}

export function toPublicDevice(device: BrowserDevice): PublicBrowserDevice {
  return {
    id: device.id,
    name: device.name,
    family: device.family,
    browserName: device.browserName,
    profileLabel: device.profileLabel,
    packageVersion: device.packageVersion,
    packageKind: device.packageKind,
    online: sockets.has(device.id),
    needsYou: device.needsYou,
    versionSkew: versionSkew(device.packageVersion),
    lastSeenAt: device.lastSeenAt,
    ...(device.octoUuid ? { octoUuid: device.octoUuid } : {}),
  }
}

export async function listDevices(userId: string): Promise<PublicBrowserDevice[]> {
  if (hasDb && prisma) {
    try {
      const rows = await prisma.browserDevice.findMany({ where: { userId } })
      return rows.map((r) => {
        const cached = devices.get(r.id)
        const dev: BrowserDevice = {
          id: r.id,
          userId: r.userId,
          name: r.name,
          family: familyOf(r.family),
          browserName: r.browserName,
          profileLabel: r.profileLabel,
          packageVersion: r.packageVersion,
          packageKind: familyOf(r.packageKind || r.family),
          installId: r.installId,
          tokenHash: r.tokenHash,
          pairedAt: r.pairedAt.toISOString(),
          lastSeenAt: r.lastSeenAt.toISOString(),
          needsYou: (r.needsYou as any) || null,
          octoLocalAvailable: cached?.octoLocalAvailable,
        }
        devices.set(dev.id, dev)
        byInstall.set(dev.installId, dev.id)
        byToken.set(dev.tokenHash, dev.id)
        return toPublicDevice(dev)
      })
    } catch { /* fallback to memory */ }
  }
  return [...devices.values()].filter((device) => device.userId === userId).map(toPublicDevice)
}

export async function getDevice(id: string): Promise<BrowserDevice | undefined> {
  const cached = devices.get(id)
  if (cached) return cached
  if (hasDb && prisma) {
    try {
      const r = await prisma.browserDevice.findUnique({ where: { id } })
      if (r) {
        const dev: BrowserDevice = {
          id: r.id,
          userId: r.userId,
          name: r.name,
          family: familyOf(r.family),
          browserName: r.browserName,
          profileLabel: r.profileLabel,
          packageVersion: r.packageVersion,
          packageKind: familyOf(r.packageKind || r.family),
          installId: r.installId,
          tokenHash: r.tokenHash,
          pairedAt: r.pairedAt.toISOString(),
          lastSeenAt: r.lastSeenAt.toISOString(),
          needsYou: (r.needsYou as any) || null,
        }
        devices.set(dev.id, dev)
        byInstall.set(dev.installId, dev.id)
        byToken.set(dev.tokenHash, dev.id)
        return dev
      }
    } catch { /* ignore */ }
  }
  return undefined
}

export function isDeviceLive(userId: string, deviceId: string | undefined): boolean {
  if (!deviceId) return false
  const cached = devices.get(deviceId)
  return !!cached && cached.userId === userId && sockets.has(deviceId)
}

export async function deviceOwnedBy(userId: string, deviceId: string | undefined): Promise<boolean> {
  if (!deviceId) return false
  const device = await getDevice(deviceId)
  return !!device && device.userId === userId
}

export function createPairCode(userId: string): { code: string; expiresAt: string } {
  const code = randomBytes(9).toString('base64url')
  const expiresAt = Date.now() + PAIR_TTL_MS
  pairCodes.set(code, { userId, expiresAt })
  return { code, expiresAt: new Date(expiresAt).toISOString() }
}

export async function renameDevice(userId: string, deviceId: string, name: string): Promise<PublicBrowserDevice | null> {
  const trimmed = name.trim().slice(0, 80)
  if (!trimmed) return null
  const cached = devices.get(deviceId)
  if (cached && cached.userId === userId) {
    cached.name = trimmed
  }
  if (hasDb && prisma) {
    try {
      const updated = await prisma.browserDevice.updateMany({
        where: { id: deviceId, userId },
        data: { name: trimmed },
      })
      if (updated.count === 0 && !cached) return null
    } catch { /* ignore */ }
  }
  const device = await getDevice(deviceId)
  if (!device || device.userId !== userId) return null
  return toPublicDevice(device)
}

export async function unpairDevice(userId: string, deviceId: string): Promise<boolean> {
  const cached = devices.get(deviceId)
  if (cached && cached.userId !== userId) return false

  devices.delete(deviceId)
  if (cached) {
    if (byInstall.get(cached.installId) === deviceId) byInstall.delete(cached.installId)
    if (byToken.get(cached.tokenHash) === deviceId) byToken.delete(cached.tokenHash)
  }
  const state = sockets.get(deviceId)
  if (state) {
    sockets.delete(deviceId)
    try { state.socket.close(4000, 'unpaired') } catch { /* gone */ }
  }
  for (const run of runs.values()) {
    if (run.deviceId === deviceId) run.revoked = true
  }
  for (const grant of grants.values()) {
    if (grant.deviceId === deviceId) grant.revoked = true
  }

  if (hasDb && prisma) {
    try {
      const deleted = await prisma.browserDevice.deleteMany({ where: { id: deviceId, userId } })
      if (!cached && deleted.count === 0) return false
    } catch { /* ignore */ }
  } else if (!cached) {
    return false
  }
  return true
}

/** Issue a secure, short-lived BrowserGrant for Build/Chat/Bot (Decisions 10, 11). */
export async function createBrowserGrant(input: {
  userId: string
  deviceId: string
  source: BrowserRunSource
}): Promise<{ grantId: string; expiresAt: string }> {
  const device = await getDevice(input.deviceId)
  if (!device || device.userId !== input.userId) {
    throw new Error('Device not found or not owned by user.')
  }
  const grantId = `bgr_${randomBytes(18).toString('base64url')}`
  const expiresAt = new Date(Date.now() + 6 * 3600 * 1000) // 6 hours TTL

  grants.set(grantId, {
    id: grantId,
    userId: input.userId,
    deviceId: input.deviceId,
    source: input.source,
    used: false,
    revoked: false,
    expiresAt,
  })

  if (hasDb && prisma) {
    await prisma.browserGrant.create({
      data: {
        id: grantId,
        userId: input.userId,
        deviceId: input.deviceId,
        source: input.source,
        expiresAt,
      },
    }).catch(() => {})
  }
  return { grantId, expiresAt: expiresAt.toISOString() }
}

/** Bind and arm a run using an explicit BrowserGrant. */
export async function armRunWithGrant(input: {
  grantId: string
  runId: string
}): Promise<ArmedRun | null> {
  let grant: { userId: string; deviceId: string; source: string; revoked: boolean; expiresAt: Date } | null = null

  const mem = grants.get(input.grantId)
  if (mem && !mem.revoked && mem.expiresAt.getTime() > Date.now() && (!mem.runId || mem.runId === input.runId)) {
    mem.used = true
    mem.runId = input.runId
    grant = mem
  }

  if (!grant && hasDb && prisma) {
    try {
      const row = await prisma.browserGrant.findUnique({ where: { id: input.grantId } })
      if (row && !row.revoked && row.expiresAt.getTime() > Date.now() && (!row.runId || row.runId === input.runId)) {
        grant = row
        await prisma.browserGrant.update({
          where: { id: input.grantId },
          data: { runId: input.runId, used: true },
        })
      }
    } catch { /* fallback */ }
  }

  if (!grant) return null

  return armBrowserRun({
    runId: input.runId,
    userId: grant.userId,
    deviceId: grant.deviceId,
    source: grant.source as BrowserRunSource,
  })
}

/** Match an unused grant for (userId, deviceId, source) when Loop-it invokes with bridge secret. */
export async function armRunWithPendingGrant(input: {
  userId: string
  deviceId: string
  runId: string
  source: BrowserRunSource
}): Promise<ArmedRun | null> {
  for (const mem of grants.values()) {
    if (
      mem.userId === input.userId &&
      mem.deviceId === input.deviceId &&
      mem.source === input.source &&
      !mem.revoked &&
      mem.expiresAt.getTime() > Date.now() &&
      (!mem.runId || mem.runId === input.runId)
    ) {
      mem.used = true
      mem.runId = input.runId
      return armBrowserRun(input)
    }
  }
  if (hasDb && prisma) {
    try {
      const row = await prisma.browserGrant.findFirst({
        where: {
          userId: input.userId,
          deviceId: input.deviceId,
          source: input.source,
          revoked: false,
          expiresAt: { gt: new Date() },
          OR: [{ runId: null }, { runId: input.runId }],
        },
        orderBy: { createdAt: 'desc' },
      })
      if (row) {
        await prisma.browserGrant.update({
          where: { id: row.id },
          data: { runId: input.runId, used: true },
        }).catch(() => {})
        return armBrowserRun(input)
      }
    } catch { /* ignore */ }
  }
  return null
}

export function armBrowserRun(input: { runId: string; userId: string; deviceId: string; source: BrowserRunSource }): ArmedRun {
  const existing = runs.get(input.runId)
  if (existing?.revoked) return existing
  const run: ArmedRun = existing || {
    runId: input.runId,
    userId: input.userId,
    deviceId: input.deviceId,
    source: input.source,
    revoked: false,
    closeTabs: false,
    inflight: 0,
    ended: false,
    startedOctoProfiles: new Set<string>(),
  }
  run.deviceId = input.deviceId
  run.source = input.source
  runs.set(input.runId, run)
  return run
}

export function getArmedRun(runId: string): ArmedRun | undefined {
  return runs.get(runId)
}

export function releaseBrowserRuns(userId: string, source: BrowserRunSource, runId?: string) {
  if (runId) {
    const run = runs.get(runId)
    if (run && run.userId === userId) markRevoked(run, false)
    else runs.set(runId, { runId, userId, deviceId: '', source, revoked: true, closeTabs: false, inflight: 0, ended: true })
    for (const grant of grants.values()) {
      if (grant.userId === userId && grant.runId === runId) grant.revoked = true
    }
    return
  }
  for (const run of runs.values()) {
    if (run.userId === userId && run.source === source) markRevoked(run, false)
  }
  for (const grant of grants.values()) {
    if (grant.userId === userId && grant.source === source) grant.revoked = true
  }
}

export function stopBrowserRun(userId: string, runId: string) {
  return endBrowserRun(userId, runId, true)
}

export function endBrowserRun(userId: string, runId: string, closeTabs: boolean) {
  const run = runs.get(runId)
  if (!run || run.userId !== userId) return false
  markRevoked(run, closeTabs)
  return true
}

function markRevoked(run: ArmedRun, closeTabs: boolean) {
  run.revoked = true
  run.closeTabs = run.closeTabs || closeTabs
  if (shouldDetachAfterCall(run.inflight, run.revoked)) finishRun(run)
}

function finishRun(run: ArmedRun) {
  if (run.ended) return
  run.ended = true
  const state = sockets.get(run.deviceId)
  if (state && state.socket.readyState === WebSocket.OPEN) {
    state.socket.send(JSON.stringify({ type: 'end_run', runId: run.runId, closeTabs: run.closeTabs }))
    // Decision 5: Stop only Octo profiles that Loop started itself
    if (run.startedOctoProfiles && run.startedOctoProfiles.size > 0) {
      for (const uuid of run.startedOctoProfiles) {
        void sendCall(state, 'octo_local_stop', { uuid }, 5000, run.runId).catch(() => {})
      }
      run.startedOctoProfiles.clear()
    }
  }
}

function callTimeout(family: BrowserFamily): number {
  return family === 'tor' ? 70_000 : 25_000
}

export async function invokeBrowserTool(input: {
  userId: string
  deviceId: string
  runId: string
  source: BrowserRunSource
  tool: string
  args: Record<string, unknown>
}): Promise<{ content: string; data?: Record<string, unknown>; isError?: boolean }> {
  // Decision 10: Must already be an armed run for this runId and user
  const run = runs.get(input.runId)
  if (!run || run.userId !== input.userId || run.deviceId !== input.deviceId) {
    return { content: 'This browser session is not authorized for this run. Use web_search.', isError: true }
  }

  const device = await getDevice(input.deviceId)
  if (!device || device.userId !== input.userId) {
    return { content: 'That browser is not paired to this account. Use web_search.', isError: true }
  }

  const decision: BrowserCallDecision = evaluateBrowserCall({
    revoked: run.revoked,
    live: sockets.has(input.deviceId),
    family: device.family,
    tool: input.tool,
    args: input.args,
    appOrigins: appOrigins(),
  })
  if (!decision.forward) {
    return { content: decision.message || BROWSER_OFFLINE_MESSAGE, isError: true, data: { fallback: 'web_search' } }
  }
  const state = sockets.get(input.deviceId)
  if (!state) return { content: BROWSER_OFFLINE_MESSAGE, isError: true, data: { fallback: 'web_search' } }
  run.inflight += 1
  try {
    const raw = await sendCall(state, input.tool, input.args, callTimeout(device.family), input.runId)
    let safe = redactPayload(raw) as Record<string, unknown>
    if (safe.needsYou && typeof safe.needsYou === 'object') {
      const reason = String((safe.needsYou as { reason?: unknown }).reason || 'login')
      const captchaSettings = getUserCaptchaSettings(input.userId)

      // Decision 7 & 8: If captchaHandling is 'solver' and not a Tor device, try solving automatically
      if (reason === 'captcha' && captchaSettings.captchaHandling === 'solver' && device.family !== 'tor') {
        const challenge = (safe.captchaInfo || (safe.needsYou as any).captchaInfo) as CaptchaChallenge | undefined
        if (challenge && challenge.sitekey && challenge.pageUrl) {
          const solved = await trySolveCaptchaForUser({
            userId: input.userId,
            family: device.family,
            challenge,
          })
          if (solved.solved) {
            const injectedRaw = await sendCall(
              state,
              'browser_inject_captcha',
              { token: solved.token },
              callTimeout(device.family),
              input.runId,
            )
            const injectedSafe = redactPayload(injectedRaw) as Record<string, unknown>
            if (injectedSafe.ok !== false && !injectedSafe.needsYou) {
              safe = {
                ...injectedSafe,
                captchaSolved: true,
                solverProvider: solved.provider,
              }
            }
          }
        }
      }
    }

    if (safe.needsYou && typeof safe.needsYou === 'object') {
      const reason = String((safe.needsYou as { reason?: unknown }).reason || 'login')
      const captchaSettings = getUserCaptchaSettings(input.userId)
      device.needsYou = { reason, at: new Date().toISOString() }
      if (hasDb && prisma) {
        await prisma.browserDevice.updateMany({
          where: { id: device.id },
          data: { needsYou: device.needsYou as any },
        }).catch(() => {})
      }
      const label = deviceLabel(device)
      const solverSuffix = reason === 'captcha'
        ? ` (Captcha solver: ${captchaSettings.solverKeyState})`
        : ''
      return {
        content: `Continue in your browser (${label}). A ${reason === 'captcha' ? 'captcha' : reason === 'confirm' ? 'confirmation' : 'login'} is waiting in the visible window.${solverSuffix}`,
        data: {
          ...publicResult(safe),
          needsYou: true,
          deviceName: label,
          reason,
          captchaHandling: captchaSettings.captchaHandling,
          solverKeyState: captchaSettings.solverKeyState,
        },
      }
    }
    if (device.needsYou) {
      device.needsYou = null
      if (hasDb && prisma) {
        await prisma.browserDevice.updateMany({
          where: { id: device.id },
          data: { needsYou: Prisma.DbNull },
        }).catch(() => {})
      }
    }
    if (safe.ok === false) {
      return { content: String(safe.error || 'The browser action failed.'), isError: true, data: publicResult(safe) }
    }
    return { content: renderResult(input.tool, safe), data: publicResult(safe) }
  } catch (error) {
    const message = (error as Error)?.message === 'timeout'
      ? 'The paired browser did not answer in time. Use web_search for public pages.'
      : BROWSER_OFFLINE_MESSAGE
    return { content: message, isError: true, data: { fallback: 'web_search' } }
  } finally {
    run.inflight = Math.max(0, run.inflight - 1)
    if (shouldDetachAfterCall(run.inflight, run.revoked)) finishRun(run)
  }
}

function publicResult(safe: Record<string, unknown>): Record<string, unknown> {
  const clone = { ...safe }
  delete clone.runId
  return clone
}

function renderResult(tool: string, result: Record<string, unknown>): string {
  const summary = typeof result.summary === 'string' && result.summary.trim() ? result.summary.trim() : null
  const delta = (result.delta as {
    console?: Array<{ text: string; level: string }>
    network?: Array<{ method: string; url: string; status: number }>
    consoleTruncated?: number
    networkTruncated?: number
  }) || {}
  const consoleList = Array.isArray(delta.console)
    ? delta.console
    : Array.isArray(result.console)
      ? (result.console as Array<{ text: string; level: string }>)
      : []
  const networkList = Array.isArray(delta.network)
    ? delta.network
    : Array.isArray(result.network)
      ? (result.network as Array<{ method: string; url: string; status: number }>)
      : []
  const consoleTrunc = Number(delta.consoleTruncated) > 0 ? ` (+${delta.consoleTruncated} more, call browser_console)` : ''
  const networkTrunc = Number(delta.networkTruncated) > 0 ? ` (+${delta.networkTruncated} more, call browser_network)` : ''
  const consoleNote = consoleList.length ? `\n\n[Console: ${consoleList.length} line(s)${consoleTrunc}]` : ''
  const networkNote = networkList.length ? `\n[Network: ${networkList.length} request(s)${networkTrunc}]` : ''
  if (tool === 'browser_snapshot') {
    const title = result.title ? `Page: ${result.title}\n` : ''
    const body = typeof result.snapshot === 'string' ? result.snapshot : typeof result.text === 'string' ? result.text : ''
    return `${title}${body}`.trim() || 'Empty page.'
  }
  if (tool === 'browser_screenshot') {
    return summary || 'Screenshot captured.'
  }
  if (tool === 'browser_console') {
    const entries = Array.isArray(result.entries) ? result.entries : []
    return entries.map((entry) => `[${(entry as any).level || 'log'}] ${(entry as any).text || ''}`).join('\n') || 'Console log is empty.'
  }
  if (tool === 'browser_network') {
    const entries = Array.isArray(result.entries) ? result.entries : []
    return entries.map((e: any) => `${e.method || 'GET'} ${e.url || ''} ${e.status || ''}`).join('\n') || 'Network log is empty.'
  }
  return `${summary || 'Action complete.'}${consoleNote}${networkNote}`
}

function deviceLabel(device: BrowserDevice): string {
  if (device.name) return device.name
  if (device.profileLabel) return `${device.browserName} (${device.profileLabel})`
  return device.browserName
}

function sendCall(state: SocketState, tool: string, args: Record<string, unknown>, timeoutMs: number, runId?: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const id = randomBytes(8).toString('hex')
    const timer = setTimeout(() => {
      state.pending.delete(id)
      reject(new Error('timeout'))
    }, timeoutMs)
    state.pending.set(id, { resolve, timer })
    if (state.socket.readyState !== WebSocket.OPEN) {
      clearTimeout(timer)
      state.pending.delete(id)
      reject(new Error('offline'))
      return
    }
    state.socket.send(JSON.stringify({ type: 'call', id, tool, args, runId }))
  })
}

/**
 * Find a live paired Chromium extension for userId to relay Octo local API calls (127.0.0.1:58888).
 */
function findLiveRelaySocket(userId: string): { device: BrowserDevice; state: SocketState } | null {
  let fallback: { device: BrowserDevice; state: SocketState } | null = null
  for (const dev of devices.values()) {
    if (dev.userId !== userId) continue
    const st = sockets.get(dev.id)
    if (!st || st.socket.readyState !== WebSocket.OPEN) continue
    if (dev.family === 'chromium' || dev.family === 'octo') {
      if (dev.octoLocalAvailable) return { device: dev, state: st }
      if (!fallback) fallback = { device: dev, state: st }
    }
  }
  return fallback
}

export async function getOctoConnectionStatus(userId: string): Promise<{
  status: 'Connected' | 'Invalid token' | 'Desktop app not running' | 'Unreachable' | 'Not configured'
  tokenConfigured: boolean
  tokenValid: boolean
  localClientReachable: boolean
  activeProfileIds: string[]
}> {
  const connectors = configStore.listConnectors(userId)
  const octoConn = connectors.find((c) => c.type === 'octo' && c.enabled && c.config?.token)
  if (!octoConn?.config?.token) {
    return {
      status: 'Not configured',
      tokenConfigured: false,
      tokenValid: false,
      localClientReachable: false,
      activeProfileIds: [],
    }
  }

  let tokenValid = octoConn.lastTestOk !== false
  if (octoConn.lastTestOk === false) {
    const msg = (octoConn.lastTestMessage || '').toLowerCase()
    if (msg.includes('invalid')) {
      return {
        status: 'Invalid token',
        tokenConfigured: true,
        tokenValid: false,
        localClientReachable: false,
        activeProfileIds: [],
      }
    }
  }

  const relay = findLiveRelaySocket(userId)
  let localClientReachable = false
  let activeProfileIds: string[] = []
  if (relay) {
    try {
      const localRes = await sendCall(relay.state, 'octo_local_status', {}, 3500)
      localClientReachable = Boolean(localRes.reachable)
      relay.device.octoLocalAvailable = localClientReachable
      if (Array.isArray(localRes.activeProfiles)) {
        activeProfileIds = localRes.activeProfiles
          .map((p: any) => String(p?.uuid || p || ''))
          .filter(Boolean)
      }
    } catch {
      localClientReachable = false
    }
  }

  const status = !tokenValid
    ? 'Invalid token'
    : localClientReachable
      ? 'Connected'
      : 'Desktop app not running'

  return {
    status,
    tokenConfigured: true,
    tokenValid,
    localClientReachable,
    activeProfileIds,
  }
}

export async function startOctoProfileOnMachine(userId: string, uuid: string, runId?: string): Promise<{
  ok: boolean
  startedByLoop: boolean
  wsEndpoint?: string
  error?: string
}> {
  const relay = findLiveRelaySocket(userId)
  if (!relay) {
    return { ok: false, startedByLoop: false, error: 'Pair and open a Chromium or Octo extension window on this machine to reach Octo Desktop (127.0.0.1:58888).' }
  }
  try {
    const probe = await sendCall(relay.state, 'octo_local_status', {}, 3500)
    const activeList = Array.isArray(probe.activeProfiles) ? probe.activeProfiles : []
    const alreadyRunning = activeList.some((p: any) => (p?.uuid || p) === uuid)
    const started = await sendCall(relay.state, 'octo_local_start', { uuid }, 15_000)
    if (started.ok === false) {
      return { ok: false, startedByLoop: false, error: String(started.error || 'Could not start Octo profile.') }
    }
    const startedByLoop = !alreadyRunning
    if (startedByLoop && runId) {
      const run = runs.get(runId)
      if (run) {
        if (!run.startedOctoProfiles) run.startedOctoProfiles = new Set()
        run.startedOctoProfiles.add(uuid)
      }
    }
    return {
      ok: true,
      startedByLoop,
      wsEndpoint: typeof started.wsEndpoint === 'string' ? started.wsEndpoint : undefined,
    }
  } catch (err: any) {
    return { ok: false, startedByLoop: false, error: err?.message || 'Octo local client did not respond.' }
  }
}

export async function stopOctoProfileOnMachine(userId: string, uuid: string): Promise<{ ok: boolean; error?: string }> {
  const relay = findLiveRelaySocket(userId)
  if (!relay) {
    return { ok: false, error: 'No paired browser relay is online to reach Octo Desktop.' }
  }
  try {
    const res = await sendCall(relay.state, 'octo_local_stop', { uuid }, 8000)
    return { ok: res.ok !== false, ...(res.error ? { error: String(res.error) } : {}) }
  } catch (err: any) {
    return { ok: false, error: err?.message || 'Could not stop Octo profile.' }
  }
}

function bridgeSecretOk(header: string | undefined): boolean {
  const expected = process.env.BROWSER_BRIDGE_SECRET || ''
  if (!expected || !header) return false
  const a = Buffer.from(header)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

export function bridgeAuthUser(header: string | undefined, userId: unknown): string | null {
  if (!bridgeSecretOk(header)) return null
  if (typeof userId !== 'string' || !userId.trim() || userId.length > 128) return null
  return userId
}

interface Hello {
  installId: string
  family: BrowserFamily
  browserName: string
  profileLabel: string
  packageVersion: string
  packageKind: BrowserFamily
  octoLocalAvailable: boolean
}

function readHello(message: Record<string, unknown>): Hello | null {
  const installId = typeof message.installId === 'string' ? message.installId.trim() : ''
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(installId)) return null
  const browserName = typeof message.browserName === 'string' ? message.browserName.trim().slice(0, 40) : 'Browser'
  const profileLabel = typeof message.profileLabel === 'string' ? message.profileLabel.trim().slice(0, 80) : ''
  const packageVersion = typeof message.packageVersion === 'string' ? message.packageVersion.trim().slice(0, 40) : ''
  const family = familyOf(message.family)
  const packageKind = familyOf(message.packageKind || message.family)
  const octoLocalAvailable = Boolean(message.octoLocalAvailable)
  return {
    installId,
    family,
    browserName: browserName || 'Browser',
    profileLabel,
    packageVersion,
    packageKind,
    octoLocalAvailable,
  }
}

function bindSocket(device: BrowserDevice, socket: WebSocket) {
  const prev = sockets.get(device.id)
  if (prev && prev.socket !== socket) {
    try { prev.socket.close(4001, 'superseded') } catch { /* gone */ }
  }
  const state: SocketState = { socket, deviceId: device.id, pending: new Map() }
  sockets.set(device.id, state)
  socket.on('message', (data) => {
    let message: Record<string, unknown>
    try { message = JSON.parse(String(data)) } catch { return }
    if (message.type === 'result' && typeof message.id === 'string') {
      const wait = state.pending.get(message.id)
      if (wait) {
        clearTimeout(wait.timer)
        state.pending.delete(message.id)
        const payload =
          message.result && typeof message.result === 'object' && !Array.isArray(message.result)
            ? (message.result as Record<string, unknown>)
            : message
        wait.resolve(payload)
      }
    } else if (message.type === 'needs_you') {
      const reason = String(message.reason || 'login')
      device.needsYou = { reason, at: new Date().toISOString() }
      if (hasDb && prisma) {
        prisma.browserDevice.updateMany({
          where: { id: device.id },
          data: { needsYou: device.needsYou as any },
        }).catch(() => {})
      }
    } else if (message.type === 'ping') {
      try { socket.send(JSON.stringify({ type: 'pong' })) } catch { /* ignore */ }
    }
  })
  socket.on('close', () => {
    if (sockets.get(device.id) === state) sockets.delete(device.id)
    for (const wait of state.pending.values()) {
      clearTimeout(wait.timer)
      wait.resolve({ ok: false, error: 'disconnected' })
    }
    state.pending.clear()
  })
}

async function acceptDevice(
  userId: string,
  hello: Hello,
  socket: WebSocket,
): Promise<{ device: BrowserDevice; token?: string; replaced: boolean } | { error: 'paired_elsewhere' }> {
  const existingId = byInstall.get(hello.installId)
  let existing = existingId ? devices.get(existingId) : undefined

  if (!existing && hasDb && prisma) {
    try {
      const row = await prisma.browserDevice.findFirst({ where: { installId: hello.installId } })
      if (row) {
        existing = {
          id: row.id,
          userId: row.userId,
          name: row.name,
          family: familyOf(row.family),
          browserName: row.browserName,
          profileLabel: row.profileLabel,
          packageVersion: row.packageVersion,
          packageKind: familyOf(row.packageKind || row.family),
          installId: row.installId,
          tokenHash: row.tokenHash,
          pairedAt: row.pairedAt.toISOString(),
          lastSeenAt: row.lastSeenAt.toISOString(),
          needsYou: (row.needsYou as any) || null,
        }
      }
    } catch { /* ignore */ }
  }

  if (existing && existing.userId !== userId) return { error: 'paired_elsewhere' }

  const token = randomBytes(24).toString('base64url')
  const tokenHash = hashToken(token)

  const device: BrowserDevice = existing || {
    id: `brw_${randomBytes(12).toString('hex')}`,
    userId,
    name: hello.browserName,
    family: hello.family,
    browserName: hello.browserName,
    profileLabel: hello.profileLabel,
    packageVersion: hello.packageVersion,
    packageKind: hello.packageKind,
    installId: hello.installId,
    tokenHash,
    pairedAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
    needsYou: null,
    octoLocalAvailable: hello.octoLocalAvailable,
  }

  device.family = hello.family
  device.browserName = hello.browserName
  device.profileLabel = hello.profileLabel
  device.packageVersion = hello.packageVersion
  device.packageKind = hello.packageKind
  device.lastSeenAt = new Date().toISOString()
  device.tokenHash = tokenHash
  device.octoLocalAvailable = hello.octoLocalAvailable

  if (existing?.tokenHash) byToken.delete(existing.tokenHash)
  devices.set(device.id, device)
  byInstall.set(device.installId, device.id)
  byToken.set(tokenHash, device.id)

  if (hasDb && prisma) {
    try {
      await prisma.browserDevice.upsert({
        where: { userId_installId: { userId, installId: hello.installId } },
        create: {
          id: device.id,
          userId,
          name: device.name,
          family: device.family,
          browserName: device.browserName,
          profileLabel: device.profileLabel,
          packageVersion: device.packageVersion,
          packageKind: device.packageKind,
          installId: device.installId,
          tokenHash,
        },
        update: {
          name: device.name,
          family: device.family,
          browserName: device.browserName,
          profileLabel: device.profileLabel,
          packageVersion: device.packageVersion,
          packageKind: device.packageKind,
          tokenHash,
          lastSeenAt: new Date(),
        },
      })
    } catch { /* ignore */ }
  }

  bindSocket(device, socket)
  return { device, token, replaced: !!existing }
}

async function reconnectDevice(
  token: string,
  hello: Hello,
  socket: WebSocket,
): Promise<{ device: BrowserDevice } | { error: 'unauthorized' | 'paired_elsewhere' }> {
  const tokenH = hashToken(token)
  const deviceId = byToken.get(tokenH)
  let device = deviceId ? devices.get(deviceId) : undefined

  if (!device && hasDb && prisma) {
    try {
      const row = await prisma.browserDevice.findUnique({ where: { tokenHash: tokenH } })
      if (row) {
        device = {
          id: row.id,
          userId: row.userId,
          name: row.name,
          family: familyOf(row.family),
          browserName: row.browserName,
          profileLabel: row.profileLabel,
          packageVersion: row.packageVersion,
          packageKind: familyOf(row.packageKind || row.family),
          installId: row.installId,
          tokenHash: row.tokenHash,
          pairedAt: row.pairedAt.toISOString(),
          lastSeenAt: row.lastSeenAt.toISOString(),
          needsYou: (row.needsYou as any) || null,
        }
        devices.set(device.id, device)
        byInstall.set(device.installId, device.id)
        byToken.set(tokenH, device.id)
      }
    } catch { /* ignore */ }
  }

  if (!device) return { error: 'unauthorized' }
  if (device.installId !== hello.installId) return { error: 'paired_elsewhere' }

  device.family = hello.family
  device.browserName = hello.browserName
  device.profileLabel = hello.profileLabel
  device.packageVersion = hello.packageVersion
  device.packageKind = hello.packageKind
  device.lastSeenAt = new Date().toISOString()
  device.octoLocalAvailable = hello.octoLocalAvailable

  if (hasDb && prisma) {
    try {
      await prisma.browserDevice.update({
        where: { id: device.id },
        data: {
          family: device.family,
          browserName: device.browserName,
          profileLabel: device.profileLabel,
          packageVersion: device.packageVersion,
          packageKind: device.packageKind,
          lastSeenAt: new Date(),
        },
      })
    } catch { /* ignore */ }
  }

  bindSocket(device, socket)
  return { device }
}

function queryValue(url: string | undefined, key: string): string {
  if (!url || !url.includes('?')) return ''
  const value = new URLSearchParams(url.slice(url.indexOf('?') + 1)).get(key) || ''
  return value.length > 0 && value.length <= 200 ? value : ''
}

function pathOnly(url: string | undefined): string {
  return (url || '').split('?')[0]
}

export function attachBrowserSocket(server: HttpServer): void {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 })
  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (pathOnly(req.url) !== '/api/browser/pair') return
    wss.handleUpgrade(req, socket, head, (client) => greet(req, client))
  })
}

function greet(req: IncomingMessage, socket: WebSocket) {
  const code = queryValue(req.url, 'code')
  const deviceToken = queryValue(req.url, 'deviceToken')
  const fail = (error: string) => {
    try { socket.send(JSON.stringify({ type: 'error', error })) } catch { /* closed */ }
    socket.close(4002, error)
  }
  const timer = setTimeout(() => fail('timeout'), 10_000)
  socket.once('message', async (data) => {
    clearTimeout(timer)
    let message: Record<string, unknown>
    try { message = JSON.parse(String(data)) } catch { fail('invalid'); return }
    if (message.type !== 'hello') { fail('invalid'); return }
    const hello = readHello(message)
    if (!hello) { fail('invalid'); return }
    if (deviceToken) {
      const reconnected = await reconnectDevice(deviceToken, hello, socket)
      if ('error' in reconnected) { fail(reconnected.error); return }
      const captcha = getUserCaptchaSettings(reconnected.device.userId)
      socket.send(JSON.stringify({ type: 'paired', deviceId: reconnected.device.id, captchaHandling: captcha.captchaHandling }))
      return
    }
    const pending = pairCodes.get(code)
    if (!pending || pending.expiresAt < Date.now()) { fail('code'); return }
    pairCodes.delete(code)
    const accepted = await acceptDevice(pending.userId, hello, socket)
    if ('error' in accepted) { fail(accepted.error); return }
    const captcha = getUserCaptchaSettings(pending.userId)
    socket.send(JSON.stringify({
      type: 'paired',
      deviceId: accepted.device.id,
      deviceToken: accepted.token,
      captchaHandling: captcha.captchaHandling,
    }))
  })
  socket.on('error', () => clearTimeout(timer))
}

export const browserFallback = {
  offline: BROWSER_OFFLINE_MESSAGE,
  released: BROWSER_RELEASED_MESSAGE,
  onion: BROWSER_ONION_MESSAGE,
}
