/**
 * Pairing, grant issuance, captcha settings, Octo profile management, and device list for the person's browsers.
 * The WebSocket itself is attached in browserBridge.attachBrowserSocket.
 */
import express from 'express'
import { z } from 'zod'
import { authenticateToken } from './auth'
import { asyncHandler } from '../middleware/errorLogger'
import {
  BROWSER_PACKAGE_VERSION,
  bridgeAuthUser,
  createPairCode,
  createBrowserGrant,
  armRunWithGrant,
  armRunWithPendingGrant,
  getArmedRun,
  getOctoConnectionStatus,
  invokeBrowserTool,
  listDevices,
  releaseBrowserRuns,
  renameDevice,
  startOctoProfileOnMachine,
  stopBrowserRun,
  stopOctoProfileOnMachine,
  unpairDevice,
  type BrowserRunSource,
} from '../services/browserBridge'
import { getUserCaptchaSettings, setUserCaptchaSettings } from '../services/captchaSolver'
import { getUserOctoClient } from '../agent/connectors/octoConnector'

const router = express.Router()

const idParam = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/)

router.post('/pair', authenticateToken, asyncHandler(async (req, res) => {
  const userId = (req as { userId?: string }).userId
  if (!userId) return res.status(401).json({ error: 'Authentication required.' })
  const issued = createPairCode(userId)
  const captcha = getUserCaptchaSettings(userId)
  res.json({
    ...issued,
    captchaHandling: captcha.captchaHandling,
    solverKeyState: captcha.solverKeyState,
    expectedVersion: BROWSER_PACKAGE_VERSION,
  })
}))

router.get('/devices', authenticateToken, asyncHandler(async (req, res) => {
  const userId = (req as { userId?: string }).userId
  if (!userId) return res.status(401).json({ error: 'Authentication required.' })
  const devices = await listDevices(userId)
  const captcha = getUserCaptchaSettings(userId)
  res.json({
    expectedVersion: BROWSER_PACKAGE_VERSION,
    captchaHandling: captcha.captchaHandling,
    solverKeyState: captcha.solverKeyState,
    dailyCap: captcha.dailyCap,
    solvesToday: captcha.solvesToday,
    devices,
  })
}))

router.get('/settings', authenticateToken, asyncHandler(async (req, res) => {
  const userId = (req as { userId?: string }).userId
  if (!userId) return res.status(401).json({ error: 'Authentication required.' })
  res.json(getUserCaptchaSettings(userId))
}))

const settingsPatchSchema = z.object({
  captchaHandling: z.enum(['wait', 'solver']).optional(),
  dailyCap: z.number().int().min(1).max(500).optional(),
})

router.patch('/settings', authenticateToken, asyncHandler(async (req, res) => {
  const userId = (req as { userId?: string }).userId
  if (!userId) return res.status(401).json({ error: 'Authentication required.' })
  const parsed = settingsPatchSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: 'Invalid browser settings.' })
  const updated = setUserCaptchaSettings(userId, parsed.data)
  res.json(updated)
}))

router.get('/octo/status', authenticateToken, asyncHandler(async (req, res) => {
  const userId = (req as { userId?: string }).userId
  if (!userId) return res.status(401).json({ error: 'Authentication required.' })
  const status = await getOctoConnectionStatus(userId)
  res.json(status)
}))

router.get('/octo/profiles', authenticateToken, asyncHandler(async (req, res) => {
  const userId = (req as { userId?: string }).userId
  if (!userId) return res.status(401).json({ error: 'Authentication required.' })
  const client = getUserOctoClient(userId)
  if (!client) return res.status(400).json({ error: 'Octo connector is not configured.' })
  const search = typeof req.query.search === 'string' ? req.query.search : undefined
  try {
    const profiles = await client.listProfiles(search)
    res.json({ profiles })
  } catch (err: any) {
    res.status(502).json({ error: err?.message || 'Failed to list Octo profiles.' })
  }
}))

router.post('/octo/profiles', authenticateToken, asyncHandler(async (req, res) => {
  const userId = (req as { userId?: string }).userId
  if (!userId) return res.status(401).json({ error: 'Authentication required.' })
  const client = getUserOctoClient(userId)
  if (!client) return res.status(400).json({ error: 'Octo connector is not configured.' })
  const title = z.string().trim().min(1).max(100).safeParse(req.body?.title)
  if (!title.success) return res.status(400).json({ error: 'Profile title is required.' })
  try {
    const created = await client.createProfile({
      title: title.data,
      fingerprint: req.body?.fingerprint && typeof req.body.fingerprint === 'object' ? req.body.fingerprint : { os: 'win' },
      proxy: req.body?.proxy && typeof req.body.proxy === 'object' ? req.body.proxy : undefined,
      tags: Array.isArray(req.body?.tags) ? req.body.tags.map(String) : undefined,
    })
    res.status(201).json(created)
  } catch (err: any) {
    res.status(502).json({ error: err?.message || 'Failed to create Octo profile.' })
  }
}))

router.patch('/octo/profiles/:uuid', authenticateToken, asyncHandler(async (req, res) => {
  const userId = (req as { userId?: string }).userId
  if (!userId) return res.status(401).json({ error: 'Authentication required.' })
  const client = getUserOctoClient(userId)
  if (!client) return res.status(400).json({ error: 'Octo connector is not configured.' })
  const uuid = idParam.safeParse(req.params.uuid)
  if (!uuid.success) return res.status(400).json({ error: 'Invalid profile UUID.' })
  try {
    const ok = await client.updateProfile(uuid.data, {
      ...(typeof req.body?.title === 'string' ? { title: req.body.title.trim().slice(0, 100) } : {}),
      ...(req.body?.fingerprint && typeof req.body.fingerprint === 'object' ? { fingerprint: req.body.fingerprint } : {}),
      ...(req.body?.proxy && typeof req.body.proxy === 'object' ? { proxy: req.body.proxy } : {}),
      ...(Array.isArray(req.body?.tags) ? { tags: req.body.tags.map(String) } : {}),
    })
    res.json({ ok })
  } catch (err: any) {
    res.status(502).json({ error: err?.message || 'Failed to update Octo profile.' })
  }
}))

router.delete('/octo/profiles/:uuid', authenticateToken, asyncHandler(async (req, res) => {
  const userId = (req as { userId?: string }).userId
  if (!userId) return res.status(401).json({ error: 'Authentication required.' })
  const client = getUserOctoClient(userId)
  if (!client) return res.status(400).json({ error: 'Octo connector is not configured.' })
  const uuid = idParam.safeParse(req.params.uuid)
  if (!uuid.success) return res.status(400).json({ error: 'Invalid profile UUID.' })
  try {
    const ok = await client.deleteProfile(uuid.data)
    res.json({ ok })
  } catch (err: any) {
    res.status(502).json({ error: err?.message || 'Failed to delete Octo profile.' })
  }
}))

router.post('/octo/profiles/:uuid/start', authenticateToken, asyncHandler(async (req, res) => {
  const userId = (req as { userId?: string }).userId
  if (!userId) return res.status(401).json({ error: 'Authentication required.' })
  const uuid = idParam.safeParse(req.params.uuid)
  if (!uuid.success) return res.status(400).json({ error: 'Invalid profile UUID.' })
  const result = await startOctoProfileOnMachine(userId, uuid.data)
  if (!result.ok) return res.status(400).json({ error: result.error })
  res.json(result)
}))

router.post('/octo/profiles/:uuid/stop', authenticateToken, asyncHandler(async (req, res) => {
  const userId = (req as { userId?: string }).userId
  if (!userId) return res.status(401).json({ error: 'Authentication required.' })
  const uuid = idParam.safeParse(req.params.uuid)
  if (!uuid.success) return res.status(400).json({ error: 'Invalid profile UUID.' })
  const result = await stopOctoProfileOnMachine(userId, uuid.data)
  if (!result.ok) return res.status(400).json({ error: result.error })
  res.json(result)
}))

router.get('/octo/profiles/:uuid/cookies', authenticateToken, asyncHandler(async (req, res) => {
  const userId = (req as { userId?: string }).userId
  if (!userId) return res.status(401).json({ error: 'Authentication required.' })
  const client = getUserOctoClient(userId)
  if (!client) return res.status(400).json({ error: 'Octo connector is not configured.' })
  const uuid = idParam.safeParse(req.params.uuid)
  if (!uuid.success) return res.status(400).json({ error: 'Invalid profile UUID.' })
  try {
    const inspected = await client.inspectCookies(uuid.data)
    res.json(inspected)
  } catch (err: any) {
    res.status(502).json({ error: err?.message || 'Failed to inspect Octo cookies.' })
  }
}))

router.post('/octo/profiles/:uuid/cookies', authenticateToken, asyncHandler(async (req, res) => {
  const userId = (req as { userId?: string }).userId
  if (!userId) return res.status(401).json({ error: 'Authentication required.' })
  const client = getUserOctoClient(userId)
  if (!client) return res.status(400).json({ error: 'Octo connector is not configured.' })
  const uuid = idParam.safeParse(req.params.uuid)
  if (!uuid.success) return res.status(400).json({ error: 'Invalid profile UUID.' })
  const cookies = Array.isArray(req.body?.cookies) ? req.body.cookies : null
  if (!cookies) return res.status(400).json({ error: 'cookies array is required.' })
  try {
    const ok = await client.setCookies(uuid.data, cookies)
    res.json({ ok, count: cookies.length })
  } catch (err: any) {
    res.status(502).json({ error: err?.message || 'Failed to import Octo cookies.' })
  }
}))

router.delete('/octo/profiles/:uuid/cookies', authenticateToken, asyncHandler(async (req, res) => {
  const userId = (req as { userId?: string }).userId
  if (!userId) return res.status(401).json({ error: 'Authentication required.' })
  const client = getUserOctoClient(userId)
  if (!client) return res.status(400).json({ error: 'Octo connector is not configured.' })
  const uuid = idParam.safeParse(req.params.uuid)
  if (!uuid.success) return res.status(400).json({ error: 'Invalid profile UUID.' })
  try {
    const ok = await client.clearCookies(uuid.data)
    res.json({ ok })
  } catch (err: any) {
    res.status(502).json({ error: err?.message || 'Failed to clear Octo cookies.' })
  }
}))

router.patch('/devices/:id', authenticateToken, asyncHandler(async (req, res) => {
  const userId = (req as { userId?: string }).userId
  if (!userId) return res.status(401).json({ error: 'Authentication required.' })
  const id = idParam.safeParse(req.params.id)
  const name = z.string().trim().min(1).max(80).safeParse(req.body?.name)
  if (!id.success || !name.success) return res.status(400).json({ error: 'Invalid device name.' })
  const device = await renameDevice(userId, id.data, name.data)
  if (!device) return res.status(404).json({ error: 'Device not found.' })
  res.json({ device })
}))

router.delete('/devices/:id', authenticateToken, asyncHandler(async (req, res) => {
  const userId = (req as { userId?: string }).userId
  if (!userId) return res.status(401).json({ error: 'Authentication required.' })
  const id = idParam.safeParse(req.params.id)
  if (!id.success) return res.status(400).json({ error: 'Invalid device.' })
  const removed = await unpairDevice(userId, id.data)
  if (!removed) return res.status(404).json({ error: 'Device not found.' })
  res.json({ ok: true })
}))

const sourceSchema = z.enum(['chat', 'bot', 'build'])

/** Issue a single-use grant before startRun (Decisions 10, 11). */
router.post('/grants', authenticateToken, asyncHandler(async (req, res) => {
  const userId = (req as { userId?: string }).userId
  if (!userId) return res.status(401).json({ error: 'Authentication required.' })
  const deviceId = idParam.safeParse(req.body?.deviceId)
  const source = sourceSchema.safeParse(req.body?.source || 'build')
  if (!deviceId.success || !source.success) return res.status(400).json({ error: 'Invalid grant request.' })

  try {
    const grant = await createBrowserGrant({
      userId,
      deviceId: deviceId.data,
      source: source.data as BrowserRunSource,
    })
    res.json(grant)
  } catch (err: any) {
    res.status(400).json({ error: err.message || 'Could not issue grant.' })
  }
}))

router.post('/release', authenticateToken, asyncHandler(async (req, res) => {
  const userId = (req as { userId?: string }).userId
  if (!userId) return res.status(401).json({ error: 'Authentication required.' })
  const source = sourceSchema.safeParse(req.body?.source)
  const runId = req.body?.runId == null ? undefined : idParam.safeParse(req.body.runId)
  if (!source.success || (runId && !runId.success)) return res.status(400).json({ error: 'Invalid release.' })
  releaseBrowserRuns(userId, source.data, runId && runId.success ? runId.data : undefined)
  res.json({ ok: true })
}))

router.post('/runs/:runId/stop', bridgeOrUser, asyncHandler(async (req, res) => {
  const userId = (req as { userId?: string }).userId
  if (!userId) return res.status(401).json({ error: 'Authentication required.' })
  const runId = idParam.safeParse(req.params.runId)
  if (!runId.success) return res.status(400).json({ error: 'Invalid run.' })
  stopBrowserRun(userId, runId.data)
  res.json({ ok: true })
}))

const invokeBody = z.object({
  grantId: z.string().optional(),
  userId: z.string().min(1).max(128).optional(),
  deviceId: idParam.optional(),
  runId: idParam,
  tool: z.string().regex(/^browser_[a-z_]{1,40}$/),
  args: z.record(z.unknown()).default({}),
  source: sourceSchema.default('build'),
})

function bridgeOrUser(req: express.Request, res: express.Response, next: express.NextFunction) {
  const header = req.headers['x-loop-browser-bridge']
  const userId = bridgeAuthUser(typeof header === 'string' ? header : undefined, req.body?.userId)
  if (userId) {
    (req as { userId?: string }).userId = userId
    ;(req as { browserBridge?: boolean }).browserBridge = true
    return next()
  }
  return authenticateToken(req, res, next)
}

/**
 * Loop-it calls this with the bridge secret (or signed-in user for interactive turns).
 * Strictly requires either an active armed run or a valid grant (Decisions 10, 11).
 */
router.post('/invoke', bridgeOrUser, asyncHandler(async (req, res) => {
  const parsed = invokeBody.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: 'Invalid browser call.' })

  let armed = getArmedRun(parsed.data.runId)

  // If not yet armed in-memory, attempt to arm from explicit grantId
  if (!armed && parsed.data.grantId) {
    armed = (await armRunWithGrant({ grantId: parsed.data.grantId, runId: parsed.data.runId })) || undefined
  }

  // Or if called via authenticated bridge with a pending unused grant for (userId, deviceId, source)
  const callingUserId = (req as { userId?: string }).userId
  if (!armed && callingUserId && parsed.data.deviceId) {
    armed = (await armRunWithPendingGrant({
      userId: callingUserId,
      deviceId: parsed.data.deviceId,
      runId: parsed.data.runId,
      source: parsed.data.source,
    })) || undefined
  }

  if (!armed) {
    return res.status(403).json({ error: 'Run is not authorized for browser automation.' })
  }

  if (!(req as { browserBridge?: boolean }).browserBridge && callingUserId !== armed.userId) {
    return res.status(403).json({ error: 'Device belongs to another account.' })
  }

  const result = await invokeBrowserTool({
    userId: armed.userId,
    deviceId: armed.deviceId,
    runId: armed.runId,
    source: armed.source,
    tool: parsed.data.tool,
    args: parsed.data.args,
  })
  res.json(result)
}))

export default router
