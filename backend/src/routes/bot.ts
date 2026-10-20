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
import { authenticateTokenOrApiKey } from '../middleware/apiAuth'
import { asyncHandler } from '../middleware/errorLogger'
import { hasDb, prisma } from '../services/prisma'

const router = express.Router()
router.use(authenticateTokenOrApiKey)

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

/** GET /api/bot/runs/:runId/events?after=<seq> — SSE replay + live attach, owner-checked.
 *  `after` is the last event seq the client received (monotonic; survives the
 *  800-event ring buffer). */
router.get('/runs/:runId/events', asyncHandler(async (req, res) => {
  if (!hasDb || !prisma) return noDb(res)
  const { subscribe, getRun } = await import('../services/botRuns')
  const { initSSE, sendEvent, startKeepalive } = await import('../agent/streaming')
  // Ownership gate BEFORE opening the stream.
  const persisted = await getRun(req.params.runId, (req as any).userId)
  if (!persisted) return res.status(404).json({ error: 'Bot run not found' })
  const afterRaw = typeof req.query.after === 'string' ? Number(req.query.after) : 0
  const after = Number.isFinite(afterRaw) ? afterRaw : 0
  initSSE(res)
  const stopKeepalive = startKeepalive(res)
  const detach = subscribe(req.params.runId, (event) => {
    if (res.writableEnded) return
    sendEvent(res, event)
    if (event.type === 'done') { stopKeepalive(); res.end() }
  }, { after })
  if (res.writableEnded) return
  if (persisted.status !== 'running') {
    detach()
    for (const event of persisted.events) {
      const seq = (event as { seq?: number }).seq
      if (typeof seq === 'number' && seq <= after) continue
      sendEvent(res, event)
    }
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
  // A dedicated VM is destroyed when its run ends; "active" must reflect the
  // run lifecycle, not just the presence of URLs — otherwise the UI frames a
  // dead host and renders a black screen under a pulsing LIVE badge.
  const running = info.runStatus ? info.runStatus === 'running' : !info.endedAt
  const active = !info.endedAt && running
  res.json({
    active,
    reason: active ? null : (info.endedAt ? 'finished' : 'not-running'),
    sandboxId: info.sandboxId,
    viewUrl: info.viewUrl || null,
    interactiveUrl: info.takeoverRequested ? info.interactiveUrl || null : null,
    takeoverRequested: info.takeoverRequested === true,
    takeoverTimeoutMs: Number(process.env.BOT_TAKEOVER_TIMEOUT_MS) || 30 * 60_000,
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

/** GET /api/bot/memory?botId= — one bot's remembered notes (its long-term
 *  memory file, mirrored from the box). */
router.get('/memory', asyncHandler(async (req, res) => {
  const { readBotMemory } = await import('../services/botMemory')
  const botId = typeof req.query.botId === 'string' ? req.query.botId : ''
  if (!botId) return res.status(400).json({ error: 'botId is required', code: 'invalid_request' })
  res.json({ memory: readBotMemory((req as any).userId, botId) })
}))

/** GET /api/bot/routines — YOUR recurring jobs (bot + skill + schedule) with run history. */
router.get('/routines', asyncHandler(async (req, res) => {
  if (!hasDb || !prisma) return noDb(res)
  const { listRoutines } = await import('../services/routines')
  res.json({ routines: await listRoutines((req as any).userId) })
}))

/** POST /api/bot/routines { goal, schedule, skillId?, botId? } — create one. */
router.post('/routines', asyncHandler(async (req, res) => {
  if (!hasDb || !prisma) return noDb(res)
  const { createRoutine } = await import('../services/routines')
  const body = req.body || {}
  const goal = String(body.goal || '').trim()
  const schedule = String(body.schedule || '')
  if (!goal || !/^\d+[mhd]$/.test(schedule)) {
    return res.status(400).json({ error: 'A routine needs a goal and a schedule like 30m, 6h, or 1d', code: 'invalid_request' })
  }
  try {
    const routine = await createRoutine((req as any).userId, {
      goal,
      schedule,
      ...(typeof body.skillId === 'string' && body.skillId ? { skillId: body.skillId } : {}),
      ...(typeof body.botId === 'string' && body.botId ? { botId: body.botId } : {}),
    })
    res.status(201).json({ routine })
  } catch (error) {
    return botError(res, error)
  }
}))

/** PATCH /api/bot/routines/:id { paused } — pause/resume. */
router.patch('/routines/:id', asyncHandler(async (req, res) => {
  if (!hasDb || !prisma) return noDb(res)
  const { setRoutinePaused } = await import('../services/routines')
  const routine = await setRoutinePaused((req as any).userId, req.params.id, req.body?.paused === true)
  if (!routine) return res.status(404).json({ error: 'Routine not found' })
  res.json({ routine })
}))

/** DELETE /api/bot/routines/:id — cancel it for good. */
router.delete('/routines/:id', asyncHandler(async (req, res) => {
  if (!hasDb || !prisma) return noDb(res)
  const { deleteRoutine } = await import('../services/routines')
  const ok = await deleteRoutine((req as any).userId, req.params.id)
  if (!ok) return res.status(404).json({ error: 'Routine not found or already finished' })
  res.json({ ok: true })
}))

/** GET /api/bot/computer/files?path= — list a directory in YOUR box. */
router.get('/computer/files', asyncHandler(async (req, res) => {
  const { listBoxFiles, BoxFilesError } = await import('../services/boxFiles')
  try {
    const entries = await listBoxFiles((req as any).userId, typeof req.query.path === 'string' ? req.query.path : '/workspace')
    res.json({ entries })
  } catch (error) {
    if (error instanceof BoxFilesError) return res.status(error.code === 'no_box' ? 409 : error.code === 'bad_path' ? 400 : 404).json({ error: error.message, code: error.code })
    throw error
  }
}))

/** GET /api/bot/computer/file?path= — read a text file from YOUR box. */
router.get('/computer/file', asyncHandler(async (req, res) => {
  const { readBoxFile, BoxFilesError } = await import('../services/boxFiles')
  try {
    const body = await readBoxFile((req as any).userId, String(req.query.path || ''))
    res.json(body)
  } catch (error) {
    if (error instanceof BoxFilesError) return res.status(error.code === 'no_box' ? 409 : error.code === 'bad_path' ? 400 : error.code === 'too_large' ? 413 : 404).json({ error: error.message, code: error.code })
    throw error
  }
}))

/** PUT /api/bot/computer/file { path, content } — write a text file into YOUR box. */
router.put('/computer/file', express.json({ limit: '4mb' }), asyncHandler(async (req, res) => {
  const { writeBoxFile, BoxFilesError } = await import('../services/boxFiles')
  try {
    const result = await writeBoxFile((req as any).userId, String(req.body?.path || ''), String(req.body?.content ?? ''))
    res.json(result)
  } catch (error) {
    if (error instanceof BoxFilesError) return res.status(error.code === 'no_box' ? 409 : error.code === 'bad_path' ? 400 : error.code === 'too_large' ? 413 : 404).json({ error: error.message, code: error.code })
    throw error
  }
}))

/** DELETE /api/bot/computer/file?path= — remove a file or directory from YOUR box. */
router.delete('/computer/file', asyncHandler(async (req, res) => {
  const { deleteBoxPath, BoxFilesError } = await import('../services/boxFiles')
  try {
    await deleteBoxPath((req as any).userId, String(req.query.path || ''))
    res.json({ ok: true })
  } catch (error) {
    if (error instanceof BoxFilesError) return res.status(error.code === 'no_box' ? 409 : error.code === 'bad_path' ? 400 : 404).json({ error: error.message, code: error.code })
    throw error
  }
}))

/** GET /api/bot/computer — read stream state only (no boot/resume side effects).
 *  Use POST /computer/wake to boot or resume the persistent box. */
router.get('/computer', asyncHandler(async (req, res) => {
  const { getBoxStreamState, getUserBoxStatus } = await import('../services/botBox')
  const userId = (req as any).userId as string
  const state = await getBoxStreamState(userId)
  if (!state?.sandboxId) {
    return res.json({
      alive: false,
      sandboxId: null,
      viewUrl: null,
      interactiveUrl: null,
      resumed: false,
      ageMinutes: null,
      taskType: null,
      workspaceDir: '/workspace',
    })
  }
  const status = await getUserBoxStatus(userId)
  res.json({
    alive: status.alive,
    sandboxId: state.sandboxId,
    viewUrl: state.viewUrl || null,
    interactiveUrl: state.interactiveUrl || null,
    resumed: true,
    ageMinutes: state.ageMinutes ?? status.ageMinutes ?? null,
    taskType: state.taskType || 'default',
    workspaceDir: state.workspaceDir || '/workspace',
  })
}))

/** POST /api/bot/computer/wake — boot or resume YOUR persistent box (side effects
 *  + interactive VM-minute metering). Body/query: taskType optional. */
router.post('/computer/wake', asyncHandler(async (req, res) => {
  const { ensureUserBox, getUserBoxStatus } = await import('../services/botBox')
  const { recordInteractiveVmMinutes } = await import('../services/botComputerMeter')
  const userId = (req as any).userId as string
  const user = hasDb && prisma ? await prisma.user.findUnique({ where: { id: userId }, select: { email: true } }) : null
  const taskType = (
    typeof req.body?.taskType === 'string' ? req.body.taskType
      : typeof req.query.taskType === 'string' ? req.query.taskType
        : 'default'
  ) as any
  let box
  try {
    box = await ensureUserBox(userId, (user?.email || 'operator').split('@')[0], taskType)
  } catch (error: any) {
    if (error?.code === 'forbidden' || error?.code === 'quota' || error?.code === 'unavailable' || error?.code === 'invalid_request') {
      return botError(res, error)
    }
    const msg = String(error?.message || 'box boot failed')
    if (/not configured|E2B_API_KEY/i.test(msg)) {
      return res.status(503).json({ error: 'The computer provider is not configured on this deployment (E2B_API_KEY missing).', code: 'unavailable' })
    }
    return res.status(502).json({ error: `Could not boot the bot computer: ${msg}`, code: 'provider' })
  }
  // Metering must never wipe a successful boot — a thrown quota used to return
  // 402 with no stream URLs even when the box was already alive.
  await recordInteractiveVmMinutes(userId).catch(() => undefined)
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

/** POST /api/bot/computer/ws-token { sandboxId } — short-lived signed query
 *  token for the noVNC websocket (desktop Bearer sessions cannot set cookies).
 *  Client connects to …/websockify?token=<token>. */
router.post('/computer/ws-token', asyncHandler(async (req, res) => {
  if (!hasDb || !prisma) return noDb(res)
  const sandboxId = String(req.body?.sandboxId || '').trim()
  if (!/^[A-Za-z0-9]+$/.test(sandboxId)) {
    return res.status(400).json({ error: 'sandboxId is required', code: 'invalid_request' })
  }
  const userId = (req as any).userId as string
  const box = await prisma.botBox.findUnique({ where: { userId }, select: { sandboxId: true } })
  const ownsBox = box?.sandboxId === sandboxId
  let ownsRun = false
  if (!ownsBox) {
    const runs = await prisma.botRun.findMany({
      where: { task: { userId } },
      orderBy: { startedAt: 'desc' },
      take: 10,
      select: { computer: true },
    })
    ownsRun = runs.some((run) => (run.computer as { sandboxId?: string } | null)?.sandboxId === sandboxId)
  }
  if (!ownsBox && !ownsRun) {
    return res.status(403).json({ error: 'Not authorized for this sandbox', code: 'forbidden' })
  }
  const { mintNovncWsToken } = await import('../services/novncProxy')
  const minted = mintNovncWsToken(userId, sandboxId)
  res.json({ token: minted.token, expiresIn: minted.expiresIn, queryParam: 'token' })
}))

export default router
