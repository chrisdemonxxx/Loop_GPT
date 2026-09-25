/**
 * Agentic endpoints: streaming chat/agent/research runs (SSE) plus management
 * of tools, MCP servers, connectors, skills, and plugins. The stream pipeline
 * itself lives in controllers/agentStream.ts.
 */
import express from 'express'
import { asyncHandler } from '../middleware/errorLogger'
import { z } from 'zod'
import { authenticateToken } from './auth'
import { availableTools } from '../agent'
import { getAllSkills, createUserSkill, deleteUserSkill, getSkill, getSkillSource, updateUserSkill, listSkillVersions, revertSkill } from '../agent/skills/skillLoader'
import { configStore } from '../agent/configStore'
import { pluginRegistry, installDataPlugin, uninstallDataPlugin } from '../agent/plugins/pluginLoader'
import { connectorRegistry } from '../agent/connectors/connectorRegistry'
import { CONNECTOR_CATALOG, probeConnector } from '../agent/connectors/catalog'
import { isMarketplaceConnector, probeMarketplaceConnector } from '../agent/connectors/marketplaceAdapters'
import { MARKETPLACE_LIST } from '../agent/connectors/oauthProviders'
import { customToolRegistry } from '../agent/customTools'
import { mcpRegistry } from '../agent/mcp/mcpRegistry'
import { randomUUID } from 'crypto'
import { getRun as getResearchRun, listRuns as listResearchRuns } from '../services/researchRuns'
import { resolveHostedModelRequest } from '../services/hostedModelRequest'
import { resolveApproval } from '../agent/approvalStore'
import { recordUsage, estimateTokens } from '../services/billing'
import { reserveDailyCredits, dailyDispatch, cleanupDailyReservation, DailyCreditError } from '../services/dailyReservations'
import { streamAgentRun, requestLifecycle } from '../controllers/agentStream'

const router = express.Router()

// ── Extension management (skills / plugins / connectors / MCP / custom tools) ──
// All are workspace-independent, account-scoped, and backed by the JSON config
// store. Tool execution authority still comes from the per-run grant.
function noStore(res: express.Response) { res.setHeader('Cache-Control', 'no-store') }

function publicConnectorConfig(cfg: { config: Record<string, string> }) {
  // Never return secret field values.
  const out: Record<string, boolean> = {}
  for (const k of Object.keys(cfg.config || {})) out[k] = true
  return out
}

router.get('/skills', authenticateToken, (_req, res) => {
  noStore(res)
  const enabled = new Set(configStore.getEnabledSkills())
  res.json(getAllSkills().map((s) => ({ id: s.id, name: s.name, description: s.description,
    builtin: !!s.builtin, triggers: s.triggers || [], tools: s.tools || [], enabled: enabled.has(s.id) })))
})

function toStringList(v: unknown): string[] | undefined {
  if (Array.isArray(v)) return v.map(String).map((s) => s.trim()).filter(Boolean)
  if (typeof v === 'string') return v.split(',').map((s) => s.trim()).filter(Boolean)
  return undefined
}

router.post('/skills', authenticateToken, (req, res) => {
  noStore(res)
  const { name, description, instructions, triggers, tools } = req.body || {}
  if (!name || !instructions) return res.status(400).json({ error: 'name and instructions are required' })
  const skill = createUserSkill({ name: String(name), description: String(description || ''),
    instructions: String(instructions), triggers: toStringList(triggers), tools: toStringList(tools) })
  const set = new Set(configStore.getEnabledSkills()); set.add(skill.id); configStore.setEnabledSkills([...set])
  res.status(201).json({ id: skill.id, name: skill.name, description: skill.description, enabled: true, builtin: false })
})

router.post('/skills/:id', authenticateToken, (req, res) => {
  noStore(res)
  const set = new Set(configStore.getEnabledSkills())
  if (req.body?.enabled === false) set.delete(req.params.id); else set.add(req.params.id)
  configStore.setEnabledSkills([...set])
  res.json({ ok: true, enabled: set.has(req.params.id) })
})

router.delete('/skills/:id', authenticateToken, (req, res) => {
  noStore(res)
  const ok = deleteUserSkill(req.params.id)
  if (ok) { const set = new Set(configStore.getEnabledSkills()); set.delete(req.params.id); configStore.setEnabledSkills([...set]) }
  res.json({ ok })
})

/** Full skill detail incl. the raw SKILL.md source (Settings detail view). */
router.get('/skills/:id', authenticateToken, (req, res) => {
  noStore(res)
  const skill = getSkill(req.params.id)
  if (!skill) return res.status(404).json({ error: 'Skill not found' })
  const enabled = new Set(configStore.getEnabledSkills())
  res.json({
    id: skill.id, name: skill.name, description: skill.description,
    instructions: skill.instructions, triggers: skill.triggers || [], tools: skill.tools || [],
    builtin: !!skill.builtin, enabled: enabled.has(skill.id),
    source: getSkillSource(skill.id),
  })
})

/** Update a user skill (built-ins are immutable). */
router.put('/skills/:id', authenticateToken, (req, res) => {
  noStore(res)
  const { name, description, instructions, triggers, tools } = req.body || {}
  if (!name || !instructions) return res.status(400).json({ error: 'name and instructions are required' })
  const skill = updateUserSkill(req.params.id, {
    name: String(name), description: String(description || ''),
    instructions: String(instructions), triggers: toStringList(triggers), tools: toStringList(tools),
  })
  if (!skill) return res.status(400).json({ error: 'Built-in skills cannot be edited' })
  const set = new Set(configStore.getEnabledSkills()); set.add(skill.id); configStore.setEnabledSkills([...set])
  res.json({ id: skill.id, name: skill.name, description: skill.description, enabled: true, builtin: false })
})

/** Skill version history (brief §2.4 — snapshots kept on every edit). */
router.get('/skills/:id/versions', authenticateToken, (req, res) => {
  noStore(res)
  res.json({ versions: listSkillVersions(req.params.id) })
})

/** Revert a user skill to a saved version (current is snapshotted first). */
router.post('/skills/:id/revert', authenticateToken, (req, res) => {
  noStore(res)
  const version = String(req.body?.version || '')
  if (!version) return res.status(400).json({ error: 'version is required' })
  const skill = revertSkill(req.params.id, version)
  if (!skill) return res.status(400).json({ error: 'Unknown version or built-in skill' })
  const set = new Set(configStore.getEnabledSkills()); set.add(skill.id); configStore.setEnabledSkills([...set])
  res.json({ ok: true, id: skill.id, name: skill.name })
})

router.get('/plugins', authenticateToken, (_req, res) => { noStore(res); res.json(pluginRegistry.list()) })

/** Install a data plugin from a JSON manifest (brief §2.4 lifecycle).
 * Manifest: { id, name, description, tools: [{ name, description, method,
 * url, params?, headers? }] } — safe HTTP tools only, never executed code.
 * Declared BEFORE /plugins/:id so "install" isn't captured as an id. */
router.post('/plugins/install', authenticateToken, (req, res) => {
  noStore(res)
  const result = installDataPlugin(req.body)
  if ('error' in result) return res.status(400).json({ error: result.error })
  // Auto-enable on install.
  const set = new Set(configStore.getEnabledPlugins()); set.add(result.id); configStore.setEnabledPlugins([...set])
  pluginRegistry.enable(result.id)
  res.status(201).json({ ok: true, id: result.id, name: result.name, tools: result.tools.map((t) => t.name) })
})

router.post('/plugins/:id', authenticateToken, (req, res) => {
  noStore(res)
  const set = new Set(configStore.getEnabledPlugins())
  if (req.body?.enabled === false) { set.delete(req.params.id); pluginRegistry.disable(req.params.id) }
  else { set.add(req.params.id); pluginRegistry.enable(req.params.id) }
  configStore.setEnabledPlugins([...set])
  res.json({ ok: true, enabled: set.has(req.params.id) })
})

/** Uninstall a data plugin (built-ins are refused). */
router.delete('/plugins/:id', authenticateToken, (req, res) => {
  noStore(res)
  const ok = uninstallDataPlugin(req.params.id)
  if (!ok) return res.status(400).json({ error: 'Built-in or unknown plugin; only installed data plugins can be removed.' })
  const set = new Set(configStore.getEnabledPlugins()); set.delete(req.params.id); configStore.setEnabledPlugins([...set])
  res.json({ ok: true })
})

router.get('/custom-tools', authenticateToken, (_req, res) => {
  noStore(res); res.json(customToolRegistry.list().map((t) => ({ id: t.id, name: t.name, description: t.description, method: t.method, url: t.url, enabled: t.enabled })))
})

router.post('/custom-tools', authenticateToken, (req, res) => {
  noStore(res)
  const { name, description, method, url, params } = req.body || {}
  if (!name || !url) return res.status(400).json({ error: 'name and url are required' })
  if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(String(name))) return res.status(400).json({ error: 'name must be a valid identifier' })
  const cfg = { id: `custom-${randomUUID().slice(0, 8)}`, name: String(name), description: String(description || `Custom tool ${name}`),
    method: method === 'GET' ? 'GET' as const : 'POST' as const, url: String(url),
    params: Array.isArray(params) ? params : [], enabled: true }
  customToolRegistry.upsert(cfg as any)
  res.status(201).json({ id: cfg.id, name: cfg.name, url: cfg.url, method: cfg.method })
})

router.delete('/custom-tools/:id', authenticateToken, (req, res) => { noStore(res); customToolRegistry.remove(req.params.id); res.json({ ok: true }) })

router.get('/mcp-servers', authenticateToken, (_req, res) => {
  noStore(res)
  const status = new Map(mcpRegistry.status().map((s) => [s.id, s]))
  res.json(configStore.listMcpServers().map((s) => ({ id: s.id, name: s.name, transport: s.transport,
    url: s.url, command: s.command, enabled: s.enabled, runtime: status.get(s.id) || { status: 'disconnected', tools: [] } })))
})

router.post('/mcp-servers', authenticateToken, asyncHandler(async (req, res) => {
  noStore(res)
  const { name, transport, url, command, args, headers } = req.body || {}
  if (!name) return res.status(400).json({ error: 'name is required' })
  const t = transport === 'stdio' ? 'stdio' as const : 'http' as const
  if (t === 'http' && !url) return res.status(400).json({ error: 'url is required for http transport' })
  if (t === 'stdio' && !command) return res.status(400).json({ error: 'command is required for stdio transport' })
  const cfg = { id: randomUUID().slice(0, 8), name: String(name), transport: t, url: url ? String(url) : undefined,
    command: command ? String(command) : undefined, args: Array.isArray(args) ? args.map(String) : undefined,
    headers: headers && typeof headers === 'object' ? headers : undefined, enabled: true }
  configStore.saveMcpServers([...configStore.listMcpServers(), cfg])
  const result = await mcpRegistry.connectServer(cfg).catch((e: any) => ({ ok: false, error: e?.message }))
  res.status(201).json({ id: cfg.id, name: cfg.name, runtime: { status: result.ok ? 'connected' : 'error', error: (result as any).error, tools: (result as any).tools || [] } })
}))

router.delete('/mcp-servers/:id', authenticateToken, asyncHandler(async (req, res) => {
  noStore(res)
  configStore.saveMcpServers(configStore.listMcpServers().filter((s) => s.id !== req.params.id))
  await mcpRegistry.disconnectServer(req.params.id)
  res.json({ ok: true })
}))

router.get('/connectors', authenticateToken, (_req, res) => {
  noStore(res)
  res.json({ types: connectorRegistry.listTypes(),
    configured: configStore.listConnectors().map((c) => ({ id: c.id, type: c.type, name: c.name, enabled: c.enabled,
      fields: publicConnectorConfig(c), account: c.account || null,
      lastTestedAt: c.lastTestedAt || null, lastTestOk: c.lastTestOk ?? null })),
    marketplace: MARKETPLACE_LIST })
})

/** Validate credentials before saving: one safe probe against the provider.
 * (Opt out with CONNECTOR_VALIDATE_ON_SAVE=false; skipped under test.) */
async function validateConnectorCredentials(type: string, config: Record<string, string>) {
  if (process.env.NODE_ENV === 'test' || process.env.CONNECTOR_VALIDATE_ON_SAVE === 'false') return { ok: true, message: 'Credential accepted.' }
  const def = CONNECTOR_CATALOG.find((d) => d.type === type)
  if (!def || def.oauth || !def.tools?.length) return { ok: true, message: 'No validation available for this connector.' }
  const probe = await probeConnector(def, { id: 'probe', type, name: def.name, config, enabled: true })
  if (probe.invalidCredentials) return { ok: false, message: `The provider rejected this credential: ${probe.message}` }
  return { ok: true, message: 'Credential accepted.' }
}

router.post('/connectors', authenticateToken, async (req, res) => {
  noStore(res)
  const { type, name, config, enabled } = req.body || {}
  if (!type || !name) return res.status(400).json({ error: 'type and name are required' })
  const known = connectorRegistry.listTypes().some((t) => t.type === type)
  if (!known) return res.status(400).json({ error: 'Unknown connector type' })
  const fields = config && typeof config === 'object' ? config : {}

  // Validate the credential against the provider before persisting anything.
  const validation = await validateConnectorCredentials(String(type), fields)
  if (!validation.ok) return res.status(400).json({ error: validation.message, code: 'INVALID_CREDENTIALS' })

  const cfg = { id: randomUUID().slice(0, 8), type: String(type), name: String(name),
    config: fields, enabled: enabled !== false,
    lastTestedAt: new Date().toISOString(), lastTestOk: true,
    lastTestMessage: validation.message }
  configStore.saveConnectors([...configStore.listConnectors(), cfg])
  connectorRegistry.activate(cfg)
  res.status(201).json({ id: cfg.id, type: cfg.type, name: cfg.name, enabled: cfg.enabled, validation: validation.message })
})

/** Test an existing connector ("Test connection" on a card). */
router.post('/connectors/:id/test', authenticateToken, async (req, res) => {
  noStore(res)
  const cfg = configStore.listConnectors().find((c) => c.id === req.params.id)
  if (!cfg) return res.status(404).json({ error: 'Connector not found' })
  let probe: { ok: boolean; invalidCredentials: boolean; message: string; ms: number }
  if (isMarketplaceConnector(cfg.type)) {
    probe = await probeMarketplaceConnector(cfg)
  } else {
    const def = CONNECTOR_CATALOG.find((d) => d.type === cfg.type)
    // The registry reference connectors (github token / http) have no catalog def.
    if (!def) probe = { ok: true, invalidCredentials: false, message: 'Connected (no probe available).', ms: 0 }
    else probe = await probeConnector(def, cfg)
  }
  const next = { ...cfg, lastTestedAt: new Date().toISOString(), lastTestOk: probe.ok, lastTestMessage: probe.message.slice(0, 300) }
  configStore.saveConnectors(configStore.listConnectors().map((c) => (c.id === cfg.id ? next : c)))
  connectorRegistry.activate(next)
  res.json({ ok: probe.ok, invalidCredentials: probe.invalidCredentials, message: probe.message, ms: probe.ms, lastTestedAt: next.lastTestedAt })
})

router.delete('/connectors/:id', authenticateToken, (req, res) => {
  noStore(res)
  configStore.saveConnectors(configStore.listConnectors().filter((c) => c.id !== req.params.id))
  connectorRegistry.deactivate(req.params.id)
  res.json({ ok: true })
})

// ── Tool permissions + audit ───────────────────────────────────────────────
const LEVELS = ['allow', 'approval', 'blocked'] as const

router.get('/permissions', authenticateToken, (_req, res) => {
  noStore(res)
  const overrides = configStore.getToolPermissions()
  res.json({
    permissions: overrides,
    tools: availableTools().map((t) => ({ name: t.name, description: t.description, source: t.source || 'builtin',
      default: t.needsApproval ? 'approval' : 'allow', effective: overrides[t.name] || (t.needsApproval ? 'approval' : 'allow') })),
  })
})

router.post('/permissions', authenticateToken, (req, res) => {
  noStore(res)
  const { name, level } = req.body || {}
  if (typeof name !== 'string' || !name) return res.status(400).json({ error: 'name is required' })
  if (!LEVELS.includes(level)) return res.status(400).json({ error: 'level must be allow, approval or blocked' })
  configStore.setToolPermission(name, level)
  res.json({ ok: true, name, level })
})

router.get('/audit', authenticateToken, (req, res) => {
  noStore(res)
  const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500)
  res.json(configStore.listToolAudit(limit))
})

// ── Durable research runs ─────────────────────────────────────────────────────
// The run survives a client reload; these read endpoints replay progress/report.
router.get('/research', authenticateToken, asyncHandler(async (req, res) => {
  noStore(res)
  const conversationId = String(req.query.conversationId || '')
  if (!conversationId) return res.status(400).json({ error: 'conversationId is required' })
  const runs = await listResearchRuns((req as any).userId, conversationId)
  res.json(runs.map((r) => ({ id: r.id, status: r.status, query: r.query, createdAt: r.createdAt,
    hasReport: !!r.report, sources: r.sources || [], events: r.events.slice(-40) })))
}))

router.get('/research/:runId', authenticateToken, asyncHandler(async (req, res) => {
  noStore(res)
  const run = await getResearchRun(req.params.runId, (req as any).userId)
  if (!run) return res.status(404).json({ error: 'Research run not found' })
  res.json(run)
}))

/**
 * POST /:conversationId/stream � full pipeline in controllers/agentStream.ts.
 * Body: { content, attachmentId?, mode?: 'chat'|'agent'|'research', model? }
 * Streams Server-Sent Events describing the run; persists both messages.
 */
router.post('/:conversationId/stream', authenticateToken, asyncHandler(streamAgentRun))

// ---- Tool catalog -----------------------------------------------------------
router.get('/tools', authenticateToken, (_req, res) => {
  res.json(
    availableTools().map((t) => ({ name: t.name, description: t.description, source: t.source || 'builtin' }))
  )
})

// ---- Loop Code: direct completions endpoint ---------------------------------
// Accepts the same format as OpenAI's /chat/completions (messages + tools) and
// streams back OpenAI-compatible SSE. Loop Code calls this to drive its local
// agent loop — the model decides which tools to call, then Loop Code executes
// them on the user's machine and sends results back in the next request.
const completionInput = z.object({
  messages: z.array(z.object({ role: z.enum(['system', 'developer', 'user', 'assistant', 'tool', 'function']) }).passthrough()).min(1).max(200),
  tools: z.array(z.record(z.unknown())).max(128).optional(),
  stream: z.boolean().default(true),
})
router.post('/completions', authenticateToken, asyncHandler(async (req, res) => {
  let target: ReturnType<typeof resolveHostedModelRequest>
  try { target = resolveHostedModelRequest(req.body) }
  catch { return res.status(400).json({ code: 'HOSTED_MODEL_REQUIRED', error: 'Invalid hosted model selection or unsupported provider override' }) }
  const input = completionInput.safeParse(req.body)
  if (!input.success) return res.status(400).json({ error: 'Invalid completion request' })
  const { messages, tools, stream } = input.data
  const userId = (req as any).userId
  const lifecycle = requestLifecycle(res)
  let reservation: Awaited<ReturnType<typeof reserveDailyCredits>> | undefined
  try {
    if (lifecycle.disconnected()) return
    try { reservation = await reserveDailyCredits(userId, 'chat', target.model) }
    catch (error) {
      if (lifecycle.disconnected()) return
      if (error instanceof DailyCreditError) return res.status(error.status).json({ error: error.message, code: error.code })
      return res.status(503).json({ error: 'Credit verification unavailable' })
    }
    if (lifecycle.disconnected()) return
    const { createClient, resolveModel } = await import('../agent/llmClient.js')
    lifecycle.check()
    const client = createClient(target.provider, target.apiKey, target.baseUrl)
    const params = { model: resolveModel(target.provider, target.model), messages,
      tools: tools?.length ? tools : undefined, tool_choice: tools?.length ? 'auto' : undefined }
    lifecycle.check()
    await dailyDispatch(reservation.id, lifecycle.signal)()
    lifecycle.check()
    if (!stream) {
      const response = await (client.chat.completions.create as any)(params, { signal: lifecycle.signal })
      await recordUsage(userId, 'chat', { reservationId: reservation.id,
        tokensIn: response.usage?.prompt_tokens ?? estimateTokens(JSON.stringify(messages)),
        tokensOut: response.usage?.completion_tokens ?? estimateTokens(JSON.stringify(response.choices || [])) })
      if (!lifecycle.disconnected()) return res.json(response)
      return
    }
    // Await upstream headers before committing SSE so startup failures can be 502.
    const streamRes = await (client.chat.completions.create as any)({ ...params, stream: true }, { signal: lifecycle.signal })
    lifecycle.check()
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Connection', 'keep-alive')
    res.flushHeaders?.()
    let output = ''
    let usage: { prompt_tokens?: number; completion_tokens?: number } | undefined
    const terminalChunks: string[] = []
    for await (const chunk of streamRes) {
      if (lifecycle.disconnected()) break
      if (chunk.usage) usage = chunk.usage
      output += JSON.stringify(chunk.choices || [])
      const frame = `data: ${JSON.stringify(chunk)}\n\n`
      // Keep the terminal tail in order, but publish success only after capture.
      if (terminalChunks.length || chunk.choices?.some((choice: any) => choice.finish_reason != null)) terminalChunks.push(frame)
      else res.write(frame)
    }
    if (lifecycle.disconnected()) throw new Error('Request cancelled after dispatch')
    await recordUsage(userId, 'chat', { reservationId: reservation.id,
      tokensIn: usage?.prompt_tokens ?? estimateTokens(JSON.stringify(messages)), tokensOut: usage?.completion_tokens ?? estimateTokens(output) })
    if (!lifecycle.disconnected()) {
      for (const frame of terminalChunks) res.write(frame)
      res.write('data: [DONE]\n\n')
      res.end()
    }
  } catch {
    if (lifecycle.disconnected()) return
    if (!res.headersSent) return res.status(502).json({ error: 'Model request failed' })
    res.write(`data: ${JSON.stringify({ error: 'Model request failed' })}\n\n`)
    res.end()
  } finally {
    try { await cleanupDailyReservation(reservation?.id) }
    finally { lifecycle.dispose() }
  }
}))

/** POST /api/agent/:conversationId/approve — resolve a tool approval decision. */
router.post('/:conversationId/approve', authenticateToken, asyncHandler(async (req, res) => {
  const { conversationId } = req.params
  const { toolName, approved } = req.body || {}
  if (typeof toolName !== 'string' || !toolName || typeof approved !== 'boolean') {
    return res.status(400).json({ error: 'toolName (string) and approved (boolean) are required.' })
  }
  const ok = resolveApproval(conversationId, toolName, approved)
  if (!ok) return res.status(404).json({ error: 'No pending approval for this tool in this conversation.' })
  res.status(200).json({ ok: true })
}))

export default router
