import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-ext-tenancy-'))
process.env.AGENT_DATA_DIR = path.join(tmpRoot, 'data')
process.env.AGENT_SKILLS_DIR = path.join(tmpRoot, 'skills')

import { configStore } from '../configStore'
import { buildCustomTool, customToolRegistry, CustomToolError } from '../customTools'
import { isReservedToolName, BUILTIN_TOOL_NAMES } from '../reservedNames'
import { availableTools } from '../index'
import { permissionFor, requiresInteractivePause } from '../agentRuntime'
import { storeApproval, resolveApproval, waitForApproval, clearApproval } from '../approvalStore'

const ALICE = 'user-alice'
const BOB = 'user-bob'

afterAll(() => { fs.rmSync(tmpRoot, { recursive: true, force: true }) })
beforeEach(() => {
  configStore.saveCustomTools(ALICE, [])
  configStore.saveCustomTools(BOB, [])
})

function webhook(ownerId: string, name: string, id = `ct-${name}`) {
  return buildCustomTool(ownerId, { id, name, url: 'https://hooks.example.com/run?q={q}', params: [{ name: 'q', type: 'string' }] })
}

describe('reserved tool names', () => {
  it.each([...BUILTIN_TOOL_NAMES])('rejects a custom tool named after built-in %s', (name) => {
    expect(() => webhook(ALICE, name)).toThrow(CustomToolError)
  })
  it.each(['Web_Search', 'EXECUTE_CODE', 'connector__x__api_request', 'mcp__srv__tool', 'computer_anything', 'loop_admin', 'system_prompt'])(
    'treats %s as reserved (case-insensitive, namespaced prefixes)', (name) => {
      expect(isReservedToolName(name)).toBe(true)
    })
  it('accepts an ordinary name', () => {
    expect(isReservedToolName('get_weather')).toBe(false)
    expect(webhook(ALICE, 'get_weather').ownerId).toBe(ALICE)
  })
  it('never lets a stored tool with a reserved name shadow the built-in', () => {
    // Simulates a pre-existing record written before the guard existed.
    configStore.saveCustomTools(ALICE, [{ ...webhook(ALICE, 'safe_name'), name: 'web_search' }])
    expect(customToolRegistry.toolsFor(ALICE)).toHaveLength(0)
    const web = availableTools(ALICE).filter((t) => t.name === 'web_search')
    expect(web).toHaveLength(1)
    expect(web[0].source ?? 'builtin').toBe('builtin')
  })
  it.each(['http://127.0.0.1/hook', 'http://169.254.169.254/latest/meta-data', 'https://{host}.example.com/x', 'file:///etc/passwd', 'http://localhost:3001/api'])(
    'rejects a non-public or host-templated URL %s', (url) => {
      expect(() => buildCustomTool(ALICE, { id: 'x', name: 'probe', url })).toThrow(CustomToolError)
    })
})

describe('per-user extension tenancy', () => {
  it('exposes a custom tool only to its owner', () => {
    customToolRegistry.upsert(ALICE, webhook(ALICE, 'alice_hook'))
    expect(availableTools(ALICE).some((t) => t.name === 'alice_hook')).toBe(true)
    expect(availableTools(BOB).some((t) => t.name === 'alice_hook')).toBe(false)
    expect(availableTools().some((t) => t.name === 'alice_hook')).toBe(false)
  })
  it('does not let another user delete the tool', () => {
    customToolRegistry.upsert(ALICE, webhook(ALICE, 'alice_hook'))
    expect(customToolRegistry.remove(BOB, 'ct-alice_hook')).toBe(false)
    expect(customToolRegistry.list(ALICE)).toHaveLength(1)
  })
  it('gates user extensions but not per-run workspace connection tools', () => {
    expect(permissionFor('alice_hook', false, 'custom')).toBe('approval')
    expect(permissionFor('mcp__srv__x', false, 'mcp:srv')).toBe('approval')
    expect(permissionFor('connection_abc', false, 'connection:abc')).toBe('allow')
    expect(permissionFor('connection_abc', false, 'connection:abc', { connection_abc: 'blocked' })).toBe('blocked')
  })
  it('keeps tool permission overrides per user', () => {
    configStore.setToolPermission(ALICE, 'web_search', 'blocked')
    expect(permissionFor('web_search', false, 'builtin', configStore.getToolPermissions(ALICE))).toBe('blocked')
    expect(permissionFor('web_search', false, 'builtin', configStore.getToolPermissions(BOB))).toBe('allow')
  })
})

describe('create_custom_tool always needs a human decision', () => {
  it('cannot be relaxed to allow by an override', () => {
    expect(permissionFor('create_custom_tool', false, 'builtin', { create_custom_tool: 'allow' })).toBe('approval')
    expect(permissionFor('create_custom_tool', false, 'builtin', { create_custom_tool: 'blocked' })).toBe('blocked')
  })
  it('pauses even with auto-approve on, unless blocked', () => {
    expect(requiresInteractivePause('approval', false, true, 'create_custom_tool')).toBe(true)
    expect(requiresInteractivePause('blocked', false, true, 'create_custom_tool')).toBe(false)
    expect(requiresInteractivePause('approval', false, true, 'web_fetch')).toBe(false)
  })
})

describe('approval ownership', () => {
  it('only the owning user can resolve a pending approval', async () => {
    const id = storeApproval(ALICE, 'conv-1', 'execute_code', {})
    expect(resolveApproval(BOB, 'conv-1', 'execute_code', true)).toBe(false)
    expect(resolveApproval(BOB, 'conv-1', 'execute_code', true, id)).toBe(false)
    expect(resolveApproval('', 'conv-1', 'execute_code', true, id)).toBe(false)
    expect(resolveApproval(ALICE, 'conv-1', 'execute_code', true, id)).toBe(true)
    await expect(waitForApproval(id, 1000)).resolves.toBe(true)
  })
  it('requires the approval id when the match is ambiguous', () => {
    const first = storeApproval(ALICE, 'conv-2', 'web_fetch', { url: 'a' })
    storeApproval(ALICE, 'conv-2', 'web_fetch', { url: 'b' })
    expect(resolveApproval(ALICE, 'conv-2', 'web_fetch', true)).toBe(false)
    expect(resolveApproval(ALICE, 'conv-2', 'web_fetch', false, first)).toBe(true)
    clearApproval('conv-2', ALICE)
  })
  it('clearing one user\'s conversation leaves other users\' approvals alone', async () => {
    const bobs = storeApproval(BOB, 'conv-3', 'execute_code', {})
    storeApproval(ALICE, 'conv-3', 'execute_code', {})
    clearApproval('conv-3', ALICE)
    expect(resolveApproval(BOB, 'conv-3', 'execute_code', false, bobs)).toBe(true)
    await expect(waitForApproval(bobs, 1000)).resolves.toBe(false)
  })
})
