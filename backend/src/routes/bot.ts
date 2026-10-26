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
router.use((req, _res, next) => {
  const userId = (req as any).userId as string | undefined
  if (userId) {
    void import('../services/botActivity').then(({ touchBotActive }) => touchBotActive(userId)).catch(() => undefined)
  }
  next()
})

export const botShareRoutes = express.Router()
botShareRoutes.get('/:token', asyncHandler(async (req, res) => {
  const { readShare } = await import('../services/botLibrary')
  const item = readShare(req.params.token, new Date())
  if (!item) return res.status(404).json({ error: 'Share link is not active' })
  res.json({ name: item.name, kind: item.kind, path: item.path })
}))

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

/** POST /api/bot/skills — create a skill through the account skill loader. */
router.post('/skills', asyncHandler(async (req, res) => {
  const { postBotSkill } = await import('../services/botSkills')
  const result = postBotSkill((req as any).userId, req.body || {})
  res.status(result.status).json(result.body)
}))

/** GET /api/bot/skills/:id — source for the editor. */
router.get('/skills/:id', asyncHandler(async (req, res) => {
  const { getBotSkill } = await import('../services/botSkills')
  const result = getBotSkill((req as any).userId, req.params.id)
  res.status(result.status).json(result.body)
}))

/** PUT /api/bot/skills/:id — update one of the caller's skills. */
router.put('/skills/:id', asyncHandler(async (req, res) => {
  const { putBotSkill } = await import('../services/botSkills')
  const result = putBotSkill((req as any).userId, req.params.id, req.body || {})
  res.status(result.status).json(result.body)
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
  const conversationId = typeof req.query.conversationId === 'string' ? req.query.conversationId : undefined
  const userId = (req as any).userId as string
  const tasks = await listAgentTasks({ status, limit, conversationId, scope: { userId } })
  const botId = typeof req.query.botId === 'string' ? req.query.botId : ''
  if (!botId) return res.json({ tasks })
  const { readChatCursor, visibleChatTasks } = await import('../services/botChat')
  res.json({ tasks: visibleChatTasks(tasks, readChatCursor(userId, botId)) })
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

/** POST /api/bot/runs/:runId/teach-steps — append one operator input event.
 *  Body: { at, kind: 'click'|'key'|'type', x?, y?, key?, text? }.
 *  x/y are framebuffer pixels (1366×768), not CSS pixels.
 *  An owned, still-running teach run stores the step even if takeover has
 *  not been persisted yet. { ok: true, stored: false } means this is not a
 *  live teach run (or the step log is full) and the step was not kept. */
router.post('/runs/:runId/teach-steps', asyncHandler(async (req, res) => {
  if (!hasDb || !prisma) return noDb(res)
  const { recordTeachStep } = await import('../services/teachSteps')
  const result = await recordTeachStep(req.params.runId, (req as any).userId, req.body)
  if (!result.ok) {
    return res.status(result.status).json({ error: result.error, ...(result.code ? { code: result.code } : {}) })
  }
  res.json({ ok: true, stored: result.stored })
}))

/** GET /api/bot/memory?botId= — one bot's remembered notes (its long-term
 *  memory file, mirrored from the box). */
router.get('/memory', asyncHandler(async (req, res) => {
  const { memoriesForViewer, readBotMemory } = await import('../services/botMemory')
  const botId = typeof req.query.botId === 'string' ? req.query.botId : ''
  if (!botId) return res.status(400).json({ error: 'botId is required', code: 'invalid_request' })
  const userId = (req as any).userId as string
  const visible = memoriesForViewer(userId, botId, userId)
  res.json({ memory: readBotMemory(userId, botId), memories: visible.memories })
}))

router.post('/memory', asyncHandler(async (req, res) => {
  const { addBotMemory } = await import('../services/botMemory')
  const botId = String(req.body?.botId || '')
  const content = String(req.body?.content || '')
  const visibility = req.body?.visibility === 'team' ? 'team' : 'private'
  const entry = addBotMemory((req as any).userId, botId, content, visibility)
  if (!entry) return res.status(400).json({ error: 'Could not save that memory', code: 'invalid_request' })
  res.status(201).json({ memory: entry })
}))

router.delete('/memory/:id', asyncHandler(async (req, res) => {
  const { deleteBotMemory } = await import('../services/botMemory')
  const botId = typeof req.query.botId === 'string' ? req.query.botId : ''
  if (!botId) return res.status(400).json({ error: 'botId is required', code: 'invalid_request' })
  const ok = deleteBotMemory((req as any).userId, botId, req.params.id)
  if (!ok) return res.status(404).json({ error: 'Memory not found' })
  res.json({ ok: true })
}))

/** GET /api/bot/routines — YOUR recurring jobs (bot + skill + schedule) with run history. */
router.get('/routines', asyncHandler(async (req, res) => {
  if (!hasDb || !prisma) return noDb(res)
  const { listRoutines, pauseRoutinesForAway } = await import('../services/routines')
  const { awayRoutineIds } = await import('../services/routineSchedule')
  const { readBotActive } = await import('../services/botActivity')
  const userId = (req as any).userId as string
  let routines = await listRoutines(userId)
  const lastActive = readBotActive(userId)
  const awayIds = lastActive
    ? awayRoutineIds(routines.map((routine) => ({
      id: routine.id,
      autoPauseWhenAway: routine.autoPauseWhenAway,
      paused: routine.paused,
    })), lastActive, new Date())
    : []
  if (awayIds.length) {
    await pauseRoutinesForAway(userId, awayIds)
    routines = await listRoutines(userId)
  }
  res.json({ routines, awayPaused: awayIds })
}))

/** POST /api/bot/routines { goal, schedule, skillId?, botId? } — create one. */
router.post('/routines', asyncHandler(async (req, res) => {
  if (!hasDb || !prisma) return noDb(res)
  const { createRoutine } = await import('../services/routines')
  const body = req.body || {}
  const goal = String(body.goal || '').trim()
  const schedule = String(body.schedule || '')
  const { isValidSchedule } = await import('../services/routineSchedule')
  if (!goal || !isValidSchedule(schedule)) {
    return res.status(400).json({ error: 'A routine needs a goal and a schedule like 30m, daily@09:30, or weekdays@09:30', code: 'invalid_request' })
  }
  try {
    const routine = await createRoutine((req as any).userId, {
      goal,
      schedule,
      ...(typeof body.skillId === 'string' && body.skillId ? { skillId: body.skillId } : {}),
      ...(typeof body.botId === 'string' && body.botId ? { botId: body.botId } : {}),
      ...(Array.isArray(body.allowedTools) ? { allowedTools: body.allowedTools } : {}),
      ...(body.computer && typeof body.computer === 'object' ? { computer: body.computer } : {}),
      ...(typeof body.conversationId === 'string' && body.conversationId ? { conversationId: body.conversationId } : {}),
    })
    res.status(201).json({ routine })
  } catch (error) {
    if (error instanceof Error && error.name === 'ZodError') {
      return res.status(400).json({ error: 'Invalid routine', code: 'invalid_request' })
    }
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

const BOX_FILE_CODES = new Set(['no_box', 'bad_path', 'too_large', 'not_found', 'io'])

async function sendBoxFileError(res: express.Response, error: unknown): Promise<boolean> {
  const code = error && typeof error === 'object' ? (error as { code?: string }).code : undefined
  if (error instanceof Error && code && BOX_FILE_CODES.has(code)) {
    const { boxFileHttpStatus } = await import('../services/boxFiles')
    res.status(boxFileHttpStatus(code)).json({ error: error.message, code })
    return true
  }
  return false
}

/** GET /api/bot/computer/files?path= — list a directory in YOUR box. */
router.get('/computer/files', asyncHandler(async (req, res) => {
  const { listBoxFiles } = await import('../services/boxFiles')
  try {
    const entries = await listBoxFiles((req as any).userId, typeof req.query.path === 'string' ? req.query.path : '/workspace')
    res.json({ entries })
  } catch (error) {
    if (await sendBoxFileError(res, error)) return
    return botError(res, error)
  }
}))

/** GET /api/bot/computer/file?path= — read a text file from YOUR box. */
router.get('/computer/file', asyncHandler(async (req, res) => {
  const { readBoxFile } = await import('../services/boxFiles')
  try {
    const body = await readBoxFile((req as any).userId, String(req.query.path || ''))
    res.json(body)
  } catch (error) {
    if (await sendBoxFileError(res, error)) return
    return botError(res, error)
  }
}))

/** PUT /api/bot/computer/file { path, content } — write a text file into YOUR box. */
router.put('/computer/file', express.json({ limit: '4mb' }), asyncHandler(async (req, res) => {
  const { writeBoxFile } = await import('../services/boxFiles')
  try {
    const result = await writeBoxFile((req as any).userId, String(req.body?.path || ''), String(req.body?.content ?? ''))
    res.json(result)
  } catch (error) {
    if (await sendBoxFileError(res, error)) return
    return botError(res, error)
  }
}))

/** DELETE /api/bot/computer/file?path= — remove a file or directory from YOUR box. */
router.delete('/computer/file', asyncHandler(async (req, res) => {
  const { deleteBoxPath } = await import('../services/boxFiles')
  try {
    await deleteBoxPath((req as any).userId, String(req.query.path || ''))
    res.json({ ok: true })
  } catch (error) {
    if (await sendBoxFileError(res, error)) return
    return botError(res, error)
  }
}))

/** GET /api/bot/computer — read stream state only (no boot/resume side effects).
 *  Use POST /computer/wake to boot or resume the persistent box.
 *  alive is true only after this process probes the VM. A stored sandbox id
 *  with no live handle is paused, and its stream URLs stay null. */
router.get('/computer', asyncHandler(async (req, res) => {
  const { getComputerStatus } = await import('../services/botBox')
  res.json(await getComputerStatus((req as any).userId as string))
}))

/** POST /api/bot/computer/takeover { takeover } — operator control of the
 *  persistent box. Does not boot. 409 when the box is not connected. */
router.post('/computer/takeover', asyncHandler(async (req, res) => {
  if (!hasDb || !prisma) return noDb(res)
  const { setUserBoxTakeover } = await import('../services/botBox')
  const takeover = req.body?.takeover === true
  try {
    res.json(await setUserBoxTakeover((req as any).userId as string, takeover))
  } catch (error) {
    const code = (error as { code?: string })?.code
    if (code === 'not_connected') {
      return res.status(409).json({ error: (error as Error).message, code })
    }
    throw error
  }
}))

/** POST /api/bot/computer/settle — bill elapsed interactive VM minutes for the
 *  open desktop. Does not boot. Zero whole minutes does not move lastSettledAt. */
router.post('/computer/settle', asyncHandler(async (req, res) => {
  if (!hasDb || !prisma) return noDb(res)
  const { recordInteractiveVmMinutes } = await import('../services/botComputerMeter')
  const minutes = await recordInteractiveVmMinutes((req as any).userId as string)
  res.json({ ok: true, minutes })
}))

function computerTaskType(req: express.Request) {
  const raw = typeof req.body?.taskType === 'string' ? req.body.taskType
    : typeof req.query.taskType === 'string' ? req.query.taskType
      : 'default'
  return raw as 'default' | 'coding' | 'research' | 'ops' | 'teach'
}

async function sendLiveBox(res: express.Response, userId: string, box: { streamUrl?: string; interactiveUrl?: string | null; sandboxId: string; resumed: boolean; ageMinutes: number; taskType: string; workspaceDir: string }) {
  const { recordInteractiveVmMinutes } = await import('../services/botComputerMeter')
  await recordInteractiveVmMinutes(userId).catch(() => undefined)
  let takeoverRequested = false
  if (hasDb && prisma) {
    const row = await prisma.botBox.findUnique({
      where: { userId },
      select: { takeoverRequested: true },
    }).catch(() => null)
    takeoverRequested = row?.takeoverRequested === true
  }
  const viewUrl = box.streamUrl || null
  const alive = Boolean(viewUrl)
  res.json({
    alive,
    sandboxId: box.sandboxId,
    viewUrl,
    interactiveUrl: alive && takeoverRequested ? (box.interactiveUrl || null) : null,
    resumed: box.resumed,
    ageMinutes: box.ageMinutes,
    taskType: box.taskType,
    workspaceDir: box.workspaceDir,
    takeoverRequested,
    paused: !alive,
  })
}

/** POST /api/bot/computer/sleep — pause the persistent desktop. Does not delete it. */
router.post('/computer/sleep', asyncHandler(async (req, res) => {
  const { pauseUserBox } = await import('../services/botBox')
  const { recordInteractiveVmMinutes } = await import('../services/botComputerMeter')
  const userId = (req as any).userId as string
  await recordInteractiveVmMinutes(userId).catch(() => undefined)
  try {
    res.json(await pauseUserBox(userId))
  } catch (error: any) {
    if (error?.code === 'not_connected') {
      return res.status(409).json({ error: error.message, code: 'not_connected' })
    }
    const msg = String(error?.message || 'Could not sleep the computer')
    return res.status(502).json({ error: msg, code: 'provider' })
  }
}))

/** POST /api/bot/computer/recover — new desktop, same mirrored files. */
router.post('/computer/recover', asyncHandler(async (req, res) => {
  const { recoverUserBox } = await import('../services/botBox')
  const userId = (req as any).userId as string
  const user = hasDb && prisma ? await prisma.user.findUnique({ where: { id: userId }, select: { email: true } }) : null
  try {
    const box = await recoverUserBox(userId, (user?.email || 'operator').split('@')[0], computerTaskType(req))
    await sendLiveBox(res, userId, box)
  } catch (error: any) {
    if (error?.code === 'forbidden' || error?.code === 'quota' || error?.code === 'unavailable' || error?.code === 'invalid_request') {
      return botError(res, error)
    }
    const msg = String(error?.message || 'Could not recover the computer')
    return res.status(502).json({ error: msg, code: 'provider' })
  }
}))

/** POST /api/bot/computer/reset { confirm: true } — baseline snapshot, no workspace restore. */
router.post('/computer/reset', asyncHandler(async (req, res) => {
  if (req.body?.confirm !== true) {
    return res.status(400).json({ error: 'Reset needs confirm: true', code: 'invalid_request' })
  }
  const { resetUserBox } = await import('../services/botBox')
  const userId = (req as any).userId as string
  const user = hasDb && prisma ? await prisma.user.findUnique({ where: { id: userId }, select: { email: true } }) : null
  try {
    const box = await resetUserBox(userId, (user?.email || 'operator').split('@')[0], { confirm: true, taskType: computerTaskType(req) })
    await sendLiveBox(res, userId, box)
  } catch (error: any) {
    if (error?.code === 'confirm_required') {
      return res.status(400).json({ error: error.message, code: 'invalid_request' })
    }
    if (error?.code === 'forbidden' || error?.code === 'quota' || error?.code === 'unavailable' || error?.code === 'invalid_request') {
      return botError(res, error)
    }
    const msg = String(error?.message || 'Could not reset the computer')
    return res.status(502).json({ error: msg, code: 'provider' })
  }
}))

/** GET /api/bot/computer/disk — free space. Does not wake an asleep computer. */
router.get('/computer/disk', asyncHandler(async (req, res) => {
  const { readBoxDisk } = await import('../services/botBox')
  res.json(await readBoxDisk((req as any).userId as string))
}))

/** POST /api/bot/computer/wake — boot or resume YOUR persistent box (side effects
 *  + interactive VM-minute metering). Body/query: taskType optional. */
router.post('/computer/wake', asyncHandler(async (req, res) => {
  const { ensureUserBox } = await import('../services/botBox')
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
  // The Computer tab draws only when alive AND viewUrl are set. A follow-up
  // probe can report paused (and drop the in-process handle) after this boot
  // already returned a stream, which left Wake on screen forever. Alive tracks
  // the stream this call just produced. interactiveUrl stays null until the
  // persistent box takeover flag is on — wake does not turn that flag on.
  let takeoverRequested = false
  if (hasDb && prisma) {
    const row = await prisma.botBox.findUnique({
      where: { userId },
      select: { takeoverRequested: true },
    }).catch(() => null)
    takeoverRequested = row?.takeoverRequested === true
  }
  const viewUrl = box.streamUrl || null
  const alive = Boolean(viewUrl)
  res.json({
    alive,
    sandboxId: box.sandboxId,
    viewUrl,
    interactiveUrl: alive && takeoverRequested ? (box.interactiveUrl || null) : null,
    resumed: box.resumed,
    ageMinutes: box.ageMinutes,
    taskType: box.taskType,
    workspaceDir: box.workspaceDir,
    takeoverRequested,
    paused: !alive,
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

router.post('/conversation/reset', asyncHandler(async (req, res) => {
  const { resetChatCursor } = await import('../services/botChat')
  const botId = String(req.body?.botId || '')
  if (!botId) return res.status(400).json({ error: 'botId is required', code: 'invalid_request' })
  const resetAt = resetChatCursor((req as any).userId, botId, new Date())
  res.json({ ok: true, resetAt })
}))

router.get('/teach/recordings', asyncHandler(async (req, res) => {
  const { listTeachRecordings } = await import('../services/teachPlan')
  const recordings = listTeachRecordings((req as any).userId).map((row) => ({
    id: row.id,
    frameCount: row.frameCount,
    stepLog: row.stepLog,
  }))
  res.json({ recordings })
}))

router.post('/runs/:runId/teach/discard', asyncHandler(async (req, res) => {
  const { teachEnd, deleteTeachRecording } = await import('../services/teachPlan')
  const end = teachEnd('discard')
  const recordingId = typeof req.body?.recordingId === 'string' ? req.body.recordingId : req.params.runId
  if (end.deleteRecording) deleteTeachRecording((req as any).userId, recordingId)
  res.json({ ok: true, discarded: true, event: end.event })
}))

router.get('/library', asyncHandler(async (req, res) => {
  const { listLibrary } = await import('../services/botLibrary')
  const botId = typeof req.query.botId === 'string' ? req.query.botId : undefined
  const kind = typeof req.query.kind === 'string' ? req.query.kind as any : undefined
  res.json({ items: listLibrary((req as any).userId, botId, kind) })
}))

router.post('/library/:id/share', asyncHandler(async (req, res) => {
  const { mintShare } = await import('../services/botLibrary')
  try {
    res.status(201).json(mintShare((req as any).userId, req.params.id, new Date()))
  } catch {
    res.status(404).json({ error: 'Library item not found' })
  }
}))

router.delete('/library/:id/share', asyncHandler(async (req, res) => {
  const { revokeShare } = await import('../services/botLibrary')
  const ok = revokeShare((req as any).userId, req.params.id)
  if (!ok) return res.status(404).json({ error: 'Share link not found' })
  res.json({ ok: true })
}))

router.get('/settings/approvals', asyncHandler(async (req, res) => {
  const { readApprovalMode } = await import('../services/botApprovals')
  res.json({ mode: readApprovalMode((req as any).userId) })
}))

router.put('/settings/approvals', asyncHandler(async (req, res) => {
  const { writeApprovalMode } = await import('../services/botApprovals')
  const mode = req.body?.mode
  if (mode !== 'ask' && mode !== 'safe' && mode !== 'accept') {
    return res.status(400).json({ error: 'mode must be ask, safe, or accept', code: 'invalid_request' })
  }
  res.json({ mode: writeApprovalMode((req as any).userId, mode) })
}))

router.post('/runs/:runId/approve', asyncHandler(async (req, res) => {
  if (!hasDb || !prisma) return noDb(res)
  const { resolveApprovalById } = await import('../agent/approvalStore')
  const run = await prisma.botRun.findUnique({
    where: { id: req.params.runId },
    include: { task: { select: { userId: true } } },
  })
  if (!run || run.task.userId !== (req as any).userId) return res.status(404).json({ error: 'Bot task not found' })
  const approvalId = String(req.body?.approvalId || '')
  if (!approvalId) return res.status(400).json({ error: 'approvalId is required', code: 'invalid_request' })
  const ok = resolveApprovalById((req as any).userId, approvalId, req.body?.approved === true)
  if (!ok) return res.status(404).json({ error: 'Approval is not pending' })
  res.json({ ok: true, approved: req.body?.approved === true })
}))

export default router
