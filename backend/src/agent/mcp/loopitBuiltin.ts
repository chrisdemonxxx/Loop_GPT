/**
 * Built-in loopit-mcp client. Code-configured from LOOPIT_MCP_URL.
 * It is not registered through the user MCP HTTP API.
 *
 * Each call mints a LOOPIT-ID for the run's user and posts JSON-RPC
 * `tools/call` through the public HTTPS fetch layer. An unset, non-https,
 * or non-public URL makes the tools unavailable.
 *
 * Schemas match Loop-it/services/loopit-mcp tools.py for start_run, get_run,
 * approve_gate, create_preview, and list_checkpoints. start_run also accepts
 * transcript and file_refs; those are folded into the MCP prompt.
 */
import { extensionFailure, extensionRequest } from '../extensionHttp'
import { validatePublicUrl } from '../../services/publicHttp'
import { prisma } from '../../services/prisma'
import {
  LoopitIdentityConfigError,
  WorkspaceMemberRole,
  loopitRoleForWorkspace,
  mintLoopitIdentityToken,
} from '../../services/loopitIdentity'
import { storeApproval, waitForApproval } from '../approvalStore'
import type { ToolContext, ToolDefinition, ToolResult } from '../types'

export const LOOPIT_MCP_SOURCE = 'mcp:loopit'
export const LOOPIT_START_TOOL = 'mcp__loopit__start_run'
export const LOOPIT_GET_TOOL = 'mcp__loopit__get_run'
export const LOOPIT_APPROVE_TOOL = 'mcp__loopit__approve_gate'
export const LOOPIT_PREVIEW_TOOL = 'mcp__loopit__create_preview'
export const LOOPIT_CHECKPOINTS_TOOL = 'mcp__loopit__list_checkpoints'

const PROMPT_LIMIT = 4000
const RUN_ID = /^run_[A-Za-z0-9_-]{4,80}$/
const WAITING_STATUS = new Set(['awaiting_approval', 'awaiting_gate'])

export const LOOPIT_BUILD_INSTRUCTIONS =
  'LOOP-IT BUILD: When the user asks to build an app, website, or product from this conversation, call mcp__loopit__start_run. ' +
  'Put the conversation transcript in transcript and attached file ids in file_refs (the server fills these in when you omit them). ' +
  'The tool stores the run id on this conversation. Tell the user they can open the preview at /build/?run=<run_id>. ' +
  'Use mcp__loopit__get_run to check status, mcp__loopit__create_preview for a preview URL, and mcp__loopit__list_checkpoints for checkpoints. ' +
  'If the run is waiting on a gate, the chat shows an approval card. Approving that card calls mcp__loopit__approve_gate. Do not approve a gate yourself without that card.'

export interface LoopitGateRef {
  run_id: string
  gate_id: string
  reason: string
}

export interface LoopitMcpRequestInit {
  method: 'POST'
  headers: Record<string, string>
  body: string
  signal?: AbortSignal
}

export interface LoopitMcpTestHooks {
  request?: (url: string, init: LoopitMcpRequestInit) => Promise<{ status: number; text: string }>
  minter?: (ctx: ToolContext) => Promise<string>
  linkRun?: (ctx: ToolContext, runId: string) => Promise<void>
  loadContext?: (ctx: ToolContext) => Promise<{ transcript: string; fileRefs: string[] }>
}

let testHooks: LoopitMcpTestHooks | null = null

/** Test-only transport and identity overrides. Production leaves this unset. */
export function setLoopitMcpTestHooks(hooks: LoopitMcpTestHooks | null) {
  testHooks = hooks
}

/** Public https endpoint, or null when the tool should disappear. */
export function loopitMcpEndpoint(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.LOOPIT_MCP_URL?.trim() ?? ''
  if (!raw) return null
  try {
    const url = validatePublicUrl(raw)
    if (url.protocol !== 'https:') return null
    return url.href
  } catch {
    return null
  }
}

export function loopitPreviewHref(runId: string): string {
  return `/build/?run=${encodeURIComponent(runId)}`
}

/** Fold the conversation into the MCP prompt. The wire body stays the real start_run schema. */
export function composeLoopitStartPrompt(input: { prompt: string; transcript?: string; fileRefs?: string[] }): string {
  const prompt = input.prompt.trim().slice(0, PROMPT_LIMIT)
  const extras: string[] = []
  const transcript = (input.transcript || '').trim()
  const refs = (input.fileRefs || []).map((ref) => ref.trim()).filter(Boolean).slice(0, 8)
  if (transcript) extras.push(`Conversation transcript:\n${transcript}`)
  if (refs.length) extras.push(`Attached files:\n${refs.map((ref) => `- ${ref}`).join('\n')}`)
  if (!extras.length) return prompt
  const extra = extras.join('\n\n')
  const room = PROMPT_LIMIT - prompt.length - 2
  if (room <= 0) return prompt
  return `${prompt}\n\n${extra.slice(0, room)}`
}

/** A run waiting on a confirmation gate, or null when there is nothing to approve. */
export function pendingLoopitGate(payload: unknown): LoopitGateRef | null {
  if (!payload || typeof payload !== 'object') return null
  const run = payload as Record<string, unknown>
  if (!WAITING_STATUS.has(String(run.status || ''))) return null
  const runId = typeof run.run_id === 'string' ? run.run_id.trim() : ''
  if (!RUN_ID.test(runId)) return null
  const gates = Array.isArray(run.gates) ? run.gates : []
  const single = run.gate && typeof run.gate === 'object' ? [run.gate] : []
  for (const candidate of [...gates, ...single]) {
    if (!candidate || typeof candidate !== 'object') continue
    const gate = candidate as Record<string, unknown>
    if (gate.status === 'approved' || gate.status === 'rejected') continue
    const gateId = typeof gate.gate_id === 'string' ? gate.gate_id.trim() : ''
    if (!gateId || gateId.length > 200) continue
    const reasonSource = typeof gate.reason === 'string' && gate.reason.trim()
      ? gate.reason
      : typeof gate.action === 'string' ? gate.action : ''
    return { run_id: runId, gate_id: gateId, reason: clipReason(reasonSource) }
  }
  return null
}

/** Approving a surfaced gate calls approve_gate. Denying it calls reject_gate. */
export function gateDecisionCall(approved: boolean, gate: LoopitGateRef): { name: 'approve_gate' | 'reject_gate'; arguments: LoopitGateRef } {
  return {
    name: approved ? 'approve_gate' : 'reject_gate',
    arguments: {
      run_id: gate.run_id,
      gate_id: gate.gate_id,
      reason: approved ? gate.reason : 'Denied from chat',
    },
  }
}

export async function mintLoopitToolToken(
  ctx: ToolContext,
  lookup: (userId: string, workspaceId?: string) => Promise<{ workspaceId: string; role: WorkspaceMemberRole } | null> = resolveLoopitMembership,
): Promise<string> {
  if (!ctx.userId) throw new LoopitIdentityConfigError('Identity subject and org are required')
  const membership = await lookup(ctx.userId, ctx.workspaceId)
  if (!membership) throw new LoopitIdentityConfigError('No workspace membership for this user')
  return mintLoopitIdentityToken({
    subject: ctx.userId,
    orgId: membership.workspaceId,
    role: loopitRoleForWorkspace(membership.role),
  })
}

/** Tool definitions, or [] when LOOPIT_MCP_URL is unset or not public https. */
export function loopitBuiltinTools(env: NodeJS.ProcessEnv = process.env): ToolDefinition[] {
  if (!loopitMcpEndpoint(env)) return []
  return [
    tool(LOOPIT_START_TOOL, 'Start a Loop-it sandboxed build run from a prompt. Include transcript and file_refs from this conversation. Returns run_id, project_id, status.', startSchema(), handleStart),
    tool(LOOPIT_GET_TOOL, 'Get a Loop-it run: status, gates, files, cost fields. A pending gate is shown in chat for approval.', objectSchema({ run_id: { type: 'string' } }, ['run_id']), handleGet),
    tool(LOOPIT_APPROVE_TOOL, 'Approve a pending destructive-action gate. Requires a reason. The chat approval card must be accepted before this runs.', objectSchema({
      run_id: { type: 'string' },
      gate_id: { type: 'string' },
      reason: { type: 'string', minLength: 1, maxLength: 1000 },
    }, ['run_id', 'gate_id', 'reason']), handleApprove, true),
    tool(LOOPIT_PREVIEW_TOOL, 'Mint a signed preview URL for a project\'s generated site.', objectSchema({
      project_id: { type: 'string' },
      path: { type: 'string' },
    }, ['project_id']), handlePreview),
    tool(LOOPIT_CHECKPOINTS_TOOL, 'List checkpoints for a Loop-it project.', objectSchema({ project_id: { type: 'string' } }, ['project_id']), handleCheckpoints),
  ]
}

function tool(
  name: string,
  description: string,
  parameters: ToolDefinition['parameters'],
  handler: ToolDefinition['handler'],
  needsApproval = false,
): ToolDefinition {
  return { name, description, parameters, source: LOOPIT_MCP_SOURCE, needsApproval, handler }
}

function startSchema(): ToolDefinition['parameters'] {
  return objectSchema({
    prompt: { type: 'string', minLength: 1, maxLength: 4000 },
    project_id: { type: 'string' },
    stack: { type: 'string' },
    difficulty: { type: 'string' },
    max_iterations: { type: 'integer', minimum: 1, maximum: 40 },
    transcript: { type: 'string', maxLength: 12000 },
    file_refs: { type: 'array', maxItems: 8, items: { type: 'string', maxLength: 200 } },
  }, ['prompt'])
}

function objectSchema(properties: Record<string, unknown>, required: string[]): ToolDefinition['parameters'] {
  return { type: 'object', properties, required, additionalProperties: false }
}

async function handleStart(args: Record<string, any>, ctx: ToolContext): Promise<ToolResult> {
  try {
    const promptText = typeof args.prompt === 'string' ? args.prompt.trim() : ''
    if (!promptText) return { content: 'prompt is required.', isError: true }
    const loaded = await loadContextIfNeeded(ctx, args)
    const prompt = composeLoopitStartPrompt({
      prompt: promptText,
      transcript: loaded.transcript,
      fileRefs: loaded.fileRefs,
    })
    const result = await callLoopitTool('start_run', startArguments(args, prompt), ctx)
    const runId = readRunId(result.json)
    if (runId) {
      try { await (testHooks?.linkRun ?? linkLoopitRun)(ctx, runId) } catch { /* the run still started */ }
    }
    const gateNote = result.isError ? null : await surfaceGate(ctx, result.json)
    const href = runId ? loopitPreviewHref(runId) : ''
    return {
      content: [result.content, gateNote, href ? `Open the preview: ${href}` : ''].filter(Boolean).join('\n'),
      isError: result.isError || gateFailed(gateNote),
      ...(runId ? { data: { loopitRunId: runId, previewHref: href } } : {}),
    }
  } catch (error) {
    return { content: failureMessage(error), isError: true }
  }
}

async function handleGet(args: Record<string, any>, ctx: ToolContext): Promise<ToolResult> {
  return callBound(ctx, 'get_run', { run_id: cleanId(args.run_id) }, true)
}

async function handleApprove(args: Record<string, any>, ctx: ToolContext): Promise<ToolResult> {
  const runId = cleanId(args.run_id)
  const gateId = cleanId(args.gate_id)
  const reason = typeof args.reason === 'string' ? args.reason.trim().slice(0, 1000) : ''
  if (!runId || !gateId || !reason) return { content: 'run_id, gate_id, and reason are required.', isError: true }
  return callBound(ctx, 'approve_gate', { run_id: runId, gate_id: gateId, reason }, false)
}

async function handlePreview(args: Record<string, any>, ctx: ToolContext): Promise<ToolResult> {
  const projectId = cleanId(args.project_id)
  if (!projectId) return { content: 'project_id is required.', isError: true }
  const body: Record<string, unknown> = { project_id: projectId }
  if (typeof args.path === 'string' && args.path.trim()) body.path = args.path.trim().slice(0, 200)
  return callBound(ctx, 'create_preview', body, false)
}

async function handleCheckpoints(args: Record<string, any>, ctx: ToolContext): Promise<ToolResult> {
  const projectId = cleanId(args.project_id)
  if (!projectId) return { content: 'project_id is required.', isError: true }
  return callBound(ctx, 'list_checkpoints', { project_id: projectId }, false)
}

async function callBound(ctx: ToolContext, name: string, arguments_: Record<string, unknown>, surface: boolean): Promise<ToolResult> {
  try {
    if (Object.values(arguments_).some((value) => value === '')) return { content: 'Missing required Loop-IT id.', isError: true }
    const result = await callLoopitTool(name, arguments_, ctx)
    const gateNote = surface && !result.isError ? await surfaceGate(ctx, result.json) : null
    const runId = readRunId(result.json)
    return {
      content: [result.content, gateNote].filter(Boolean).join('\n'),
      isError: result.isError || gateFailed(gateNote),
      ...(runId ? { data: { loopitRunId: runId, previewHref: loopitPreviewHref(runId) } } : {}),
    }
  } catch (error) {
    return { content: failureMessage(error), isError: true }
  }
}

/**
 * Raise the existing chat approval for a waiting gate. Approving resolves
 * that card and then calls approve_gate. Denying calls reject_gate.
 */
async function surfaceGate(ctx: ToolContext, payload: unknown): Promise<string | null> {
  const gate = pendingLoopitGate(payload)
  if (!gate || !ctx.userId || !ctx.conversationId) return null
  const args = { run_id: gate.run_id, gate_id: gate.gate_id, reason: gate.reason }
  const approvalId = storeApproval(ctx.userId, ctx.conversationId, LOOPIT_APPROVE_TOOL, args)
  ctx.emit({
    type: 'pending_approval',
    tool_name: LOOPIT_APPROVE_TOOL,
    args,
    approvalId,
    prompt: `Build is waiting on gate ${gate.gate_id}: ${gate.reason}`,
  })
  const approved = await waitForApproval(approvalId, 120_000, ctx.signal)
  const decision = gateDecisionCall(approved, gate)
  const arguments_: Record<string, unknown> = {
    run_id: decision.arguments.run_id,
    gate_id: decision.arguments.gate_id,
    reason: decision.arguments.reason,
  }
  const result = await callLoopitTool(decision.name, arguments_, ctx)
  if (!approved) return `Gate ${gate.gate_id} was not approved. Do not call approve_gate again.`
  if (result.isError) return `Gate approval failed: ${result.content}`
  return `Gate ${gate.gate_id} was approved from chat. Do not call approve_gate again.`
}

async function callLoopitTool(name: string, arguments_: Record<string, unknown>, ctx: ToolContext): Promise<{ content: string; isError: boolean; json: unknown }> {
  const endpoint = loopitMcpEndpoint()
  if (!endpoint) return { content: 'Loop-IT MCP is not configured.', isError: true, json: null }
  const token = await (testHooks?.minter ?? mintLoopitToolToken)(ctx)
  const request = testHooks?.request ?? defaultTransport
  const res = await request(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: arguments_ } }),
    signal: ctx.signal,
  })
  return parseMcpResponse(res.status, res.text)
}

async function defaultTransport(url: string, init: LoopitMcpRequestInit): Promise<{ status: number; text: string }> {
  const res = await extensionRequest(url, {
    method: 'POST',
    headers: init.headers,
    body: init.body,
    signal: init.signal,
    timeoutMs: 30_000,
    maxBytes: 1024 * 1024,
  })
  return { status: res.status, text: res.text }
}

function parseMcpResponse(status: number, text: string): { content: string; isError: boolean; json: unknown } {
  if (!text) return { content: status ? `Loop-IT MCP returned HTTP ${status}.` : 'Loop-IT MCP returned an empty response.', isError: true, json: null }
  let body: any
  try { body = JSON.parse(text) } catch { return { content: 'Loop-IT MCP returned a non-JSON response.', isError: true, json: null } }
  if (body?.error) {
    const message = typeof body.error.message === 'string' ? body.error.message : 'Loop-IT MCP request failed.'
    return { content: message.slice(0, 500), isError: true, json: null }
  }
  const result = body?.result
  const parts = Array.isArray(result?.content) ? result.content : []
  const content = parts.map((part: any) => (part?.type === 'text' ? String(part.text ?? '') : '')).filter(Boolean).join('\n') || '(no output)'
  let json: unknown = null
  if (content.startsWith('{') || content.startsWith('[')) {
    try { json = JSON.parse(content) } catch { json = null }
  }
  return { content, isError: result?.isError === true || status >= 400, json }
}

function startArguments(args: Record<string, any>, prompt: string): Record<string, unknown> {
  const body: Record<string, unknown> = { prompt }
  const projectId = cleanId(args.project_id)
  if (projectId) body.project_id = projectId
  if (typeof args.stack === 'string' && args.stack.trim()) body.stack = args.stack.trim().slice(0, 80)
  if (typeof args.difficulty === 'string' && args.difficulty.trim()) body.difficulty = args.difficulty.trim().slice(0, 40)
  if (typeof args.max_iterations === 'number' && Number.isInteger(args.max_iterations)) body.max_iterations = args.max_iterations
  return body
}

async function loadContextIfNeeded(ctx: ToolContext, args: Record<string, any>): Promise<{ transcript: string; fileRefs: string[] }> {
  let transcript = typeof args.transcript === 'string' ? args.transcript : ''
  let fileRefs = stringList(args.file_refs)
  if (transcript.trim() && fileRefs.length) return { transcript, fileRefs }
  let loaded = { transcript: '', fileRefs: [] as string[] }
  try { loaded = await (testHooks?.loadContext ?? loadBuildContext)(ctx) } catch { /* prompt still starts the run */ }
  if (!transcript.trim()) transcript = loaded.transcript
  if (!fileRefs.length) fileRefs = loaded.fileRefs
  return { transcript, fileRefs }
}

async function loadBuildContext(ctx: ToolContext): Promise<{ transcript: string; fileRefs: string[] }> {
  if (!prisma || !ctx.userId || !ctx.conversationId) return { transcript: '', fileRefs: [] }
  const [messages, files] = await Promise.all([
    prisma.message.findMany({
      where: { conversationId: ctx.conversationId, conversation: { userId: ctx.userId } },
      orderBy: { createdAt: 'desc' },
      take: 24,
      select: { role: true, content: true },
    }),
    prisma.privateFile.findMany({
      where: { conversationId: ctx.conversationId, userId: ctx.userId, deletedAt: null },
      orderBy: { createdAt: 'desc' },
      take: 8,
      select: { id: true, name: true },
    }),
  ])
  const transcript = [...messages].reverse().map((message) => `${message.role}: ${message.content.replace(/\s+/g, ' ').trim()}`).join('\n').slice(0, 6000)
  return { transcript, fileRefs: files.map((file) => `${file.id} (${file.name})`) }
}

async function linkLoopitRun(ctx: ToolContext, runId: string): Promise<void> {
  if (!prisma || !ctx.userId || !ctx.conversationId || !RUN_ID.test(runId)) return
  await prisma.conversation.updateMany({
    where: { id: ctx.conversationId, userId: ctx.userId },
    data: { loopitRunId: runId },
  })
}

async function resolveLoopitMembership(userId: string, workspaceId?: string): Promise<{ workspaceId: string; role: WorkspaceMemberRole } | null> {
  if (!prisma) return null
  if (workspaceId) {
    const member = await prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
      select: { role: true, workspaceId: true },
    })
    if (!member || !isWorkspaceRole(member.role)) return null
    return { workspaceId: member.workspaceId, role: member.role }
  }
  const personal = await prisma.workspace.findUnique({ where: { personalOwnerId: userId }, select: { id: true } })
  if (personal) {
    const member = await prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId: personal.id, userId } },
      select: { role: true },
    })
    if (member && isWorkspaceRole(member.role)) return { workspaceId: personal.id, role: member.role }
  }
  const fallback = await prisma.workspaceMember.findFirst({
    where: { userId },
    orderBy: [{ createdAt: 'asc' }, { workspaceId: 'asc' }],
    select: { workspaceId: true, role: true },
  })
  if (!fallback || !isWorkspaceRole(fallback.role)) return null
  return { workspaceId: fallback.workspaceId, role: fallback.role }
}

function isWorkspaceRole(role: string): role is WorkspaceMemberRole {
  return role === 'owner' || role === 'editor' || role === 'viewer'
}

function readRunId(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null
  const id = (value as { run_id?: unknown }).run_id
  return typeof id === 'string' && RUN_ID.test(id.trim()) ? id.trim() : null
}

function cleanId(value: unknown): string {
  if (typeof value !== 'string') return ''
  const id = value.trim()
  return id.length > 0 && id.length <= 200 ? id : ''
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim()).slice(0, 8)
}

function clipReason(value: string): string {
  const text = value.trim()
  return (text || 'Approved from chat').slice(0, 1000)
}

function gateFailed(note: string | null): boolean {
  return typeof note === 'string' && note.startsWith('Gate approval failed')
}

function failureMessage(error: unknown): string {
  if (error instanceof LoopitIdentityConfigError) return 'Loop-IT identity is not available for this user.'
  return extensionFailure(error)
}
