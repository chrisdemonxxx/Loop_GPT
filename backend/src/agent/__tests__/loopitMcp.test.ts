import { afterEach, describe, expect, it, vi } from 'vitest'
import { availableTools } from '../index'
import { permissionFor, requiresInteractivePause } from '../agentRuntime'
import { resolveApproval, clearApproval } from '../approvalStore'
import type { AgentEvent, ToolContext } from '../types'
import {
  LOOPIT_APPROVE_TOOL,
  LOOPIT_CHECKPOINTS_TOOL,
  LOOPIT_GET_TOOL,
  LOOPIT_PREVIEW_TOOL,
  LOOPIT_START_TOOL,
  composeLoopitStartPrompt,
  gateDecisionCall,
  loopitBuiltinTools,
  loopitPreviewHref,
  mintLoopitToolToken,
  pendingLoopitGate,
  setLoopitMcpTestHooks,
  type LoopitMcpRequestInit,
} from '../mcp/loopitBuiltin'

const USER = 'user-1'
const CONV = 'conv-1'
const ENDPOINT = 'https://loopit.example.com/mcp'
const saved = {
  url: process.env.LOOPIT_MCP_URL,
  secret: process.env.LOOPIT_IDENTITY_SECRET,
  kid: process.env.LOOPIT_IDENTITY_KID,
}

afterEach(() => {
  restore('LOOPIT_MCP_URL', saved.url)
  restore('LOOPIT_IDENTITY_SECRET', saved.secret)
  restore('LOOPIT_IDENTITY_KID', saved.kid)
  setLoopitMcpTestHooks(null)
  clearApproval(CONV, USER)
})

function restore(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

function ctx(events: AgentEvent[] = []): ToolContext {
  return { userId: USER, conversationId: CONV, workspaceId: 'org-1', emit: (event) => { events.push(event) }, scratch: {} }
}

function rpc(data: unknown) {
  return {
    status: 200,
    text: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      result: { content: [{ type: 'text', text: JSON.stringify(data) }], isError: false },
    }),
  }
}

function decodeToken(token: string) {
  const [header, payload] = token.split('.')
  return {
    header: JSON.parse(Buffer.from(header, 'base64url').toString('utf8')),
    payload: JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')),
  }
}

describe('loopit-mcp tool wiring', () => {
  it('hides the tools when LOOPIT_MCP_URL is unset or not public https', () => {
    delete process.env.LOOPIT_MCP_URL
    expect(loopitBuiltinTools()).toEqual([])
    expect(availableTools(USER).some((tool) => tool.name.startsWith('mcp__loopit__'))).toBe(false)

    for (const url of ['http://127.0.0.1:8010/mcp', 'http://loopit.example.com/mcp', 'https://loopit.internal/mcp', 'https://loopit.example.com:8443/mcp']) {
      process.env.LOOPIT_MCP_URL = url
      expect(loopitBuiltinTools(), url).toEqual([])
      expect(availableTools(USER).some((tool) => tool.source === 'mcp:loopit'), url).toBe(false)
    }
  })

  it('registers the five Loop-IT tools for a user when the public https URL is set', () => {
    process.env.LOOPIT_MCP_URL = ENDPOINT
    const tools = loopitBuiltinTools()
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      LOOPIT_APPROVE_TOOL, LOOPIT_CHECKPOINTS_TOOL, LOOPIT_GET_TOOL, LOOPIT_PREVIEW_TOOL, LOOPIT_START_TOOL,
    ].sort())
    const start = tools.find((tool) => tool.name === LOOPIT_START_TOOL)!
    const approve = tools.find((tool) => tool.name === LOOPIT_APPROVE_TOOL)!
    expect(start.parameters.required).toEqual(['prompt'])
    expect(start.parameters.properties?.transcript).toBeTruthy()
    expect(start.parameters.properties?.file_refs).toBeTruthy()
    expect(approve.parameters.required).toEqual(['run_id', 'gate_id', 'reason'])
    expect(approve.needsApproval).toBe(true)
    expect(tools.find((tool) => tool.name === LOOPIT_GET_TOOL)?.parameters.required).toEqual(['run_id'])
    expect(tools.find((tool) => tool.name === LOOPIT_PREVIEW_TOOL)?.parameters.required).toEqual(['project_id'])
    expect(tools.find((tool) => tool.name === LOOPIT_CHECKPOINTS_TOOL)?.parameters.required).toEqual(['project_id'])

    const offered = availableTools(USER).filter((tool) => tool.source === 'mcp:loopit').map((tool) => tool.name)
    expect(offered).toEqual(expect.arrayContaining([LOOPIT_START_TOOL, LOOPIT_APPROVE_TOOL]))
    expect(availableTools().some((tool) => tool.source === 'mcp:loopit')).toBe(false)
    expect(requiresInteractivePause(permissionFor(LOOPIT_APPROVE_TOOL, true, 'mcp:loopit'), false, true, LOOPIT_APPROVE_TOOL)).toBe(true)
    expect(requiresInteractivePause(permissionFor(LOOPIT_START_TOOL, false, 'mcp:loopit'), false, true, LOOPIT_START_TOOL)).toBe(false)
  })

  it('sends start_run with the transcript and file refs, and a per-user LOOPIT-ID', async () => {
    process.env.LOOPIT_MCP_URL = ENDPOINT
    process.env.LOOPIT_IDENTITY_SECRET = 'test-secret-value'
    process.env.LOOPIT_IDENTITY_KID = 'test-kid'
    const calls: Array<{ url: string; init: LoopitMcpRequestInit }> = []
    const linked: string[] = []
    setLoopitMcpTestHooks({
      request: async (url, init) => {
        calls.push({ url, init })
        return rpc({ run_id: 'run_abc123', project_id: 'proj_1', status: 'running' })
      },
      minter: (toolCtx) => mintLoopitToolToken(toolCtx, async () => ({ workspaceId: 'org-1', role: 'editor' })),
      linkRun: async (_toolCtx, runId) => { linked.push(runId) },
      loadContext: async () => ({ transcript: 'user: build a todo app', fileRefs: ['file-9 (spec.txt)'] }),
    })
    const start = loopitBuiltinTools().find((tool) => tool.name === LOOPIT_START_TOOL)!
    const result = await start.handler({ prompt: 'Build the app we discussed' }, ctx())
    expect(result.isError).toBeFalsy()
    expect(linked).toEqual(['run_abc123'])
    expect(result.data).toMatchObject({ loopitRunId: 'run_abc123', previewHref: loopitPreviewHref('run_abc123') })
    expect(result.content).toContain('/build/?run=run_abc123')
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe(ENDPOINT)
    const body = JSON.parse(calls[0].init.body)
    expect(body.method).toBe('tools/call')
    expect(body.params.name).toBe('start_run')
    expect(Object.keys(body.params.arguments).sort()).toEqual(['prompt'])
    expect(body.params.arguments.prompt).toContain('Build the app we discussed')
    expect(body.params.arguments.prompt).toContain('user: build a todo app')
    expect(body.params.arguments.prompt).toContain('file-9 (spec.txt)')
    expect(body.params.arguments.prompt.length).toBeLessThanOrEqual(4000)
    const token = calls[0].init.headers.Authorization.replace(/^Bearer /, '')
    const decoded = decodeToken(token)
    expect(decoded.header.typ).toBe('LOOPIT-ID')
    expect(decoded.payload.sub).toBe(USER)
    expect(decoded.payload.org).toBe('org-1')
    expect(decoded.payload.role).toBe('member')
  })
})

describe('loopit gate to chat approval', () => {
  it('maps a waiting gate onto approve_gate and only calls it after the chat approves', async () => {
    process.env.LOOPIT_MCP_URL = ENDPOINT
    process.env.LOOPIT_IDENTITY_SECRET = 'test-secret-value'
    process.env.LOOPIT_IDENTITY_KID = 'test-kid'
    const names: string[] = []
    setLoopitMcpTestHooks({
      request: async (_url, init) => {
        const body = JSON.parse(init.body)
        names.push(body.params.name)
        if (body.params.name === 'get_run') {
          return rpc({
            run_id: 'run_abc123',
            status: 'awaiting_approval',
            gates: [{ gate_id: 'gate_1', reason: 'apply patch', status: 'pending' }],
          })
        }
        expect(body.params.name).toBe('approve_gate')
        expect(body.params.arguments).toEqual({ run_id: 'run_abc123', gate_id: 'gate_1', reason: 'apply patch' })
        const decoded = decodeToken(init.headers.Authorization.replace(/^Bearer /, ''))
        expect(decoded.header.typ).toBe('LOOPIT-ID')
        return rpc({ status: 'approved' })
      },
      minter: (toolCtx) => mintLoopitToolToken(toolCtx, async () => ({ workspaceId: 'org-1', role: 'owner' })),
    })
    const gate = pendingLoopitGate({
      status: 'awaiting_approval',
      run_id: 'run_abc123',
      gates: [{ gate_id: 'gate_1', reason: 'apply patch', status: 'pending' }],
    })
    expect(gate).toEqual({ run_id: 'run_abc123', gate_id: 'gate_1', reason: 'apply patch' })
    expect(gateDecisionCall(true, gate!).name).toBe('approve_gate')

    const events: AgentEvent[] = []
    const getRun = loopitBuiltinTools().find((tool) => tool.name === LOOPIT_GET_TOOL)!
    const pending = getRun.handler({ run_id: 'run_abc123' }, ctx(events))
    await vi.waitFor(() => expect(events.some((event) => event.type === 'pending_approval')).toBe(true))
    const approval = events.find((event) => event.type === 'pending_approval')
    if (!approval || approval.type !== 'pending_approval') throw new Error('missing approval')
    expect(approval.tool_name).toBe(LOOPIT_APPROVE_TOOL)
    expect(names).toEqual(['get_run'])
    expect(resolveApproval(USER, CONV, approval.tool_name, true, approval.approvalId)).toBe(true)
    const result = await pending
    expect(result.isError).toBeFalsy()
    expect(result.content).toContain('approved from chat')
    expect(names).toEqual(['get_run', 'approve_gate'])
  })

  it('does not call approve_gate when the chat denies the gate', async () => {
    process.env.LOOPIT_MCP_URL = ENDPOINT
    process.env.LOOPIT_IDENTITY_SECRET = 'test-secret-value'
    process.env.LOOPIT_IDENTITY_KID = 'test-kid'
    const names: string[] = []
    setLoopitMcpTestHooks({
      request: async (_url, init) => {
        const body = JSON.parse(init.body)
        names.push(body.params.name)
        if (body.params.name === 'get_run') {
          return rpc({
            run_id: 'run_abc123',
            status: 'awaiting_approval',
            gate: { gate_id: 'gate_9', reason: 'drop table', status: 'pending' },
          })
        }
        expect(body.params.name).toBe('reject_gate')
        expect(body.params.arguments.reason).toBe('Denied from chat')
        return rpc({ status: 'rejected' })
      },
      minter: (toolCtx) => mintLoopitToolToken(toolCtx, async () => ({ workspaceId: 'org-1', role: 'owner' })),
    })
    const events: AgentEvent[] = []
    const getRun = loopitBuiltinTools().find((tool) => tool.name === LOOPIT_GET_TOOL)!
    const pending = getRun.handler({ run_id: 'run_abc123' }, ctx(events))
    await vi.waitFor(() => expect(events.some((event) => event.type === 'pending_approval')).toBe(true))
    const approval = events.find((event) => event.type === 'pending_approval')
    if (!approval || approval.type !== 'pending_approval') throw new Error('missing approval')
    expect(resolveApproval(USER, CONV, approval.tool_name, false, approval.approvalId)).toBe(true)
    const result = await pending
    expect(result.content).toContain('not approved')
    expect(names).toEqual(['get_run', 'reject_gate'])
    expect(pendingLoopitGate({ status: 'running', run_id: 'run_abc123', gates: [{ gate_id: 'gate_9', reason: 'x', status: 'pending' }] })).toBeNull()
  })
})

describe('composeLoopitStartPrompt', () => {
  it('keeps the transcript and file refs inside the MCP prompt limit', () => {
    const prompt = composeLoopitStartPrompt({
      prompt: 'Build it',
      transcript: 'user: hello',
      fileRefs: ['file-1 (notes.txt)'],
    })
    expect(prompt).toContain('Build it')
    expect(prompt).toContain('user: hello')
    expect(prompt).toContain('file-1 (notes.txt)')
    expect(prompt.length).toBeLessThanOrEqual(4000)
    const huge = composeLoopitStartPrompt({ prompt: 'P', transcript: 'x'.repeat(9000), fileRefs: [] })
    expect(huge.length).toBeLessThanOrEqual(4000)
    expect(huge.startsWith('P')).toBe(true)
  })
})
