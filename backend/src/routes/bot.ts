/**
 * User-facing Loop Bot API (B2): enqueue and drive YOUR OWN autonomous agent
 * tasks. Mirrors /api/admin/bot/* but every read/write is owner-scoped
 * (B1) — a user can never see, cancel, or take over another account's run,
 * and system tasks (NULL owner) stay invisible here.
 *
 * Computer sessions bill VM minutes against the owner's per-plan daily budget
 * (B4, enforced at enqueue) and model work against daily credits (kind 'bot').
 */
import express from 'express'
import { authenticateToken } from './auth'
import { asyncHandler } from '../middleware/errorLogger'
import { hasDb, prisma } from '../services/prisma'

const router = express.Router()
router.use(authenticateToken)

const noDb = (res: express.Response) => res.status(503).json({ error: 'Loop Bot requires a database.' })

function botError(res: express.Response, error: any) {
  const code = error?.code
  if (code === 'not_found') return res.status(404).json({ error: 'Bot task not found' })
  if (code === 'invalid_request') return res.status(400).json({ error: 'Invalid bot task', code })
  if (code === 'forbidden') return res.status(403).json({ error: 'Dedicated computer sessions require a Pro plan or above.', code })
  if (code === 'quota') return res.status(402).json({ error: "Today's dedicated-computer budget is used up. It resets with your daily credits.", code })
  if (code === 'conflict') return res.status(409).json({ error: 'Task is not cancellable in its current state', code })
  if (code === 'DAILY_ACCOUNTING_UNAVAILABLE' || code === 'unavailable') return res.status(503).json({ error: error.message, code })
  throw error
}

/** POST /api/bot/tasks — enqueue a task you own. */
router.post('/tasks', asyncHandler(async (req, res) => {
  if (!hasDb || !prisma) return noDb(res)
  const { enqueueAgentTask, enqueueInput } = await import('../services/agentTasks')
  const parsed = enqueueInput.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: 'Invalid bot task', code: 'invalid_request' })
  const userId = (req as any).userId as string
  try {
    const task = await enqueueAgentTask(parsed.data, userId, userId)
    res.status(201).json({ ok: true, task, suggestedSkills: task.suggestedSkills })
  } catch (error) {
    return botError(res, error)
  }
}))

/** GET /api/bot/skills — the caller's own skill library (taught + picked). */
router.get('/skills', asyncHandler(async (req, res) => {
  const { loadSkillsForUser } = await import('../agent/skills/skillLoader')
  const botId = typeof req.query.botId === 'string' ? req.query.botId : ''
  const skills = loadSkillsForUser((req as any).userId).filter((skill) => !botId || skill.botId === botId)
  res.json({ skills })
}))

/** DELETE /api/bot/skills/:id — remove one of the caller's own skills. */
router.delete('/skills/:id', asyncHandler(async (req, res) => {
  const { deleteUserSkillForUser } = await import('../agent/skills/skillLoader')
  const ok = deleteUserSkillForUser((req as any).userId, req.params.id)
  if (!ok) return res.status(404).json({ error: 'Skill not found' })
  res.json({ ok: true })
}))

/** GET /api/bot/quota — your dedicated-computer budget for today (read-only):
 *  the daily cap, minutes used, minutes remaining, and whether the plan can
 *  provision computers at all. Powers the honest quota UI (no guessing from
 *  enqueue errors). */
router.get('/quota', asyncHandler(async (req, res) => {
  if (!hasDb || !prisma) return noDb(res)
  const userId = (req as any).userId as string
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { plan: true, role: true, unlimited: true, creditsResetAt: true },
  })
  if (!user) return res.status(404).json({ error: 'User not found' })
  const { BOT_VM_MINUTES_PER_DAY } = await import('../services/agentTasks')
  const unlimited = user.role === 'admin' || user.unlimited
  const cap = unlimited ? null : (BOT_VM_MINUTES_PER_DAY[user.plan] ?? 0)
  const rows = await prisma.$queryRaw<{ used: number | bigint }[]>`
    SELECT COALESCE(SUM((r."computer"->>'minutes')::int), 0)::bigint AS used
    FROM "BotRun" r JOIN "AgentTask" t ON t."id" = r."taskId"
    WHERE t."userId" = ${userId} AND r."startedAt" >= ${user.creditsResetAt}`
  const used = Number(rows[0]?.used ?? 0)
  const { isE2BConfigured } = await import('../services/e2bDesktop')
  res.json({
    plan: user.plan,
    unlimited,
    computerAllowed: unlimited || (cap !== null && cap > 0),
    computerConfigured: isE2BConfigured(),
    cap,
    used,
    remaining: unlimited ? null : Math.max(0, (cap ?? 0) - used),
    resetsAt: user.creditsResetAt,
  })
}))

/** GET /api/bot/tasks?status=&limit= — your queue only. */
router.get('/tasks', asyncHandler(async (req, res) => {
  if (!hasDb || !prisma) return noDb(res)
  const { listAgentTasks } = await import('../services/agentTasks')
  const status = typeof req.query.status === 'string' ? req.query.status : undefined
  const limit = Number(req.query.limit) || 50
  res.json({ tasks: await listAgentTasks({ status, limit, scope: { userId: (req as any).userId } }) })
}))

/** GET /api/bot/tasks/:id — your task, with its recent runs. */
router.get('/tasks/:id', asyncHandler(async (req, res) => {
  if (!hasDb || !prisma) return noDb(res)
  const { getAgentTask } = await import('../services/agentTasks')
  try {
    res.json(await getAgentTask(req.params.id, { userId: (req as any).userId }))
  } catch (error) {
    return botError(res, error)
  }
}))

/** POST /api/bot/tasks/:id/cancel — retire/flag your own task. */
router.post('/tasks/:id/cancel', asyncHandler(async (req, res) => {
  if (!hasDb || !prisma) return noDb(res)
  const { cancelAgentTask } = await import('../services/agentTasks')
  try {
    res.json(await cancelAgentTask(req.params.id, { userId: (req as any).userId }))
  } catch (error) {
    return botError(res, error)
  }
}))

/** GET /api/bot/runs/:runId — your run view. */
router.get('/runs/:runId', asyncHandler(async (req, res) => {
  if (!hasDb || !prisma) return noDb(res)
  const { getRun } = await import('../services/botRuns')
  const run = await getRun(req.params.runId, (req as any).userId)
  if (!run) return res.status(404).json({ error: 'Bot run not found' })
  res.json(run)
}))

/** GET /api/bot/runs/:runId/events — SSE replay + live attach, owner-checked. */
router.get('/runs/:runId/events', asyncHandler(async (req, res) => {
  if (!hasDb || !prisma) return noDb(res)
  const { subscribe, getRun } = await import('../services/botRuns')
  const { initSSE, sendEvent, startKeepalive } = await import('../agent/streaming')
  // Ownership gate BEFORE opening the stream.
  const persisted = await getRun(req.params.runId, (req as any).userId)
  if (!persisted) return res.status(404).json({ error: 'Bot run not found' })
  initSSE(res)
  const stopKeepalive = startKeepalive(res)
  const detach = subscribe(req.params.runId, (event) => {
    if (res.writableEnded) return
    sendEvent(res, event)
    if (event.type === 'done') { stopKeepalive(); res.end() }
  })
  if (res.writableEnded) return
  if (persisted.status !== 'running') {
    detach()
    for (const event of persisted.events) sendEvent(res, event)
    sendEvent(res, { type: 'done' })
    stopKeepalive()
    res.end()
    return
  }
  res.on('close', () => { detach(); stopKeepalive() })
}))

/** GET /api/bot/runs/:runId/computer — your computer session (interactive URL
 *  only while you hold takeover). */
router.get('/runs/:runId/computer', asyncHandler(async (req, res) => {
  if (!hasDb || !prisma) return noDb(res)
  const { getRunComputer } = await import('../services/botRuns')
  const info = await getRunComputer(req.params.runId, (req as any).userId)
  if (!info || !info.sandboxId) return res.status(404).json({ error: 'No computer session for this run' })
  res.json({
    active: !info.endedAt,
    sandboxId: info.sandboxId,
    viewUrl: info.viewUrl || null,
    interactiveUrl: info.takeoverRequested ? info.interactiveUrl || null : null,
    takeoverRequested: info.takeoverRequested === true,
    minutes: info.minutes ?? null,
    startedAt: info.startedAt || null,
    endedAt: info.endedAt || null,
  })
}))

/** POST /api/bot/runs/:runId/takeover { takeover } — seize/release YOUR VM. */
router.post('/runs/:runId/takeover', asyncHandler(async (req, res) => {
  if (!hasDb || !prisma) return noDb(res)
  const takeover = req.body?.takeover === true
  const { setRunTakeover, getRunComputer } = await import('../services/botRuns')
  const ok = await setRunTakeover(req.params.runId, takeover, (req as any).userId)
  if (!ok) return res.status(409).json({ error: 'Run is not active' })
  const info = await getRunComputer(req.params.runId, (req as any).userId)
  res.json({ takeoverRequested: takeover, interactiveUrl: takeover ? info?.interactiveUrl || null : null })
}))

/** GET /api/bot/computer - YOUR persistent box (Grok parity): the always-on
 *  computer that exists independent of any task. Boots or resumes it on
 *  demand and returns the live stream; per-task runs attach to this same VM.
 *  Body: ?taskType=default|coding|research|ops|teach (seeds the tool pack). */
router.get('/computer', asyncHandler(async (req, res) => {
  const { ensureUserBox, getUserBoxStatus } = await import('../services/botBox')
  const userId = (req as any).userId as string
  const user = hasDb && prisma ? await prisma.user.findUnique({ where: { id: userId }, select: { email: true } }) : null
  const taskType = (typeof req.query.taskType === 'string' ? req.query.taskType : 'default') as any
  let box
  try {
    box = await ensureUserBox(userId, (user?.email || 'operator').split('@')[0], taskType)
  } catch (error: any) {
    if (error?.code === 'forbidden' || error?.code === 'quota' || error?.code === 'unavailable' || error?.code === 'invalid_request') {
      return botError(res, error)
    }
    const msg = String(error?.message || 'box boot failed')
    // Honest failure modes: provider not configured vs provider error.
    if (/not configured|E2B_API_KEY/i.test(msg)) {
      return res.status(503).json({ error: 'The computer provider is not configured on this deployment (E2B_API_KEY missing).', code: 'unavailable' })
    }
    return res.status(502).json({ error: `Could not boot the bot computer: ${msg}`, code: 'provider' })
  }
  const status = await getUserBoxStatus(userId)
  res.json({
    alive: status.alive,
    sandboxId: box.sandboxId,
    viewUrl: box.streamUrl || null,
    interactiveUrl: box.interactiveUrl || null,
    resumed: box.resumed,
    ageMinutes: box.ageMinutes,
    taskType: box.taskType,
    workspaceDir: box.workspaceDir,
  })
}))

export default router
