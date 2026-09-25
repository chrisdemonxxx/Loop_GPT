import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { Server } from 'http'
import express from 'express'

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-agent-cfg-'))
process.env.AGENT_DATA_DIR = path.join(tmpRoot, 'data')
process.env.AGENT_SKILLS_DIR = path.join(tmpRoot, 'skills')
process.env.NODE_ENV = 'development'
process.env.ENABLE_DEV_MODE = 'true'
// Connector save-validation probes the real provider; unit tests use synthetic
// tokens, so opt out (the probe path is covered by catalog unit tests).
process.env.CONNECTOR_VALIDATE_ON_SAVE = 'false'

import { initAgent, availableTools } from '../../agent'
import agentRouter from '../agent'
import { configStore } from '../../agent/configStore'

let server: Server
let base: string

// Dev mode: authenticateToken accepts no token and stamps a default user.
async function req(method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let json: any = null
  try { json = text ? JSON.parse(text) : null } catch { /* non-json */ }
  return { status: res.status, json, text }
}

beforeAll(async () => {
  await initAgent()
  const app = express()
  app.use(express.json())
  app.use('/api/agent', agentRouter)
  await new Promise<void>((resolve) => { server = app.listen(0, () => resolve()) })
  const addr = server.address() as any
  base = `http://127.0.0.1:${addr.port}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  fs.rmSync(tmpRoot, { recursive: true, force: true })
})

beforeEach(() => {
  // Reset account-scoped config between tests.
  configStore.setEnabledSkills([])
  configStore.setEnabledPlugins([])
  configStore.saveConnectors([])
  configStore.saveCustomTools([])
})

describe('agent extension configuration routes (previously 410)', () => {
  it('lists the built-in tool catalog including code execution and meta tools', async () => {
    const { status, json } = await req('GET', '/api/agent/tools')
    expect(status).toBe(200)
    const names = json.map((t: any) => t.name)
    expect(names).toContain('web_search')
    expect(names).toContain('execute_code')
    expect(names).toContain('create_skill')
    expect(names).toContain('create_custom_tool')
    expect(availableTools().some((t) => t.name === 'execute_code')).toBe(true)
  })

  it('creates, lists, toggles and deletes a user skill', async () => {
    expect((await req('GET', '/api/agent/skills')).status).toBe(200)
    const created = await req('POST', '/api/agent/skills', {
      name: 'Cold Email Writer', description: 'writes outreach', instructions: 'Write concise cold emails.',
      triggers: ['cold email'],
    })
    expect(created.status).toBe(201)
    expect(created.json.enabled).toBe(true)

    const list = await req('GET', '/api/agent/skills')
    const mine = list.json.find((s: any) => s.name === 'Cold Email Writer')
    expect(mine).toBeTruthy()
    expect(mine.enabled).toBe(true)

    expect((await req('POST', `/api/agent/skills/${mine.id}`, { enabled: false })).status).toBe(200)
    expect((await req('DELETE', `/api/agent/skills/${mine.id}`)).json.ok).toBe(true)
    const after = await req('GET', '/api/agent/skills')
    expect(after.json.find((s: any) => s.name === 'Cold Email Writer')).toBeFalsy()
  })

  it('returns skill detail with raw SKILL.md source and updates it', async () => {
    const created = await req('POST', '/api/agent/skills', {
      name: 'Meeting Notes', description: 'structured notes', instructions: 'Take structured meeting notes.',
    })
    expect(created.status).toBe(201)

    const detail = await req('GET', `/api/agent/skills/${created.json.id}`)
    expect(detail.status).toBe(200)
    expect(detail.json.instructions).toContain('structured meeting notes')
    expect(detail.json.source).toMatch(/^---\nname: Meeting Notes/)
    expect(detail.json.source).toContain('Take structured meeting notes.')

    const updated = await req('PUT', `/api/agent/skills/${created.json.id}`, {
      name: 'Meeting Notes Pro', description: 'better notes', instructions: 'Take GREAT structured notes.',
      triggers: 'meeting, notes',
    })
    expect(updated.status).toBe(200)
    const after = await req('GET', `/api/agent/skills/${created.json.id}`)
    expect(after.json.name).toBe('Meeting Notes Pro')
    expect(after.json.triggers).toEqual(['meeting', 'notes'])
    expect((await req('DELETE', `/api/agent/skills/${created.json.id}`)).json.ok).toBe(true)
  })

  it('serves built-in skill detail but refuses to edit it', async () => {
    const detail = await req('GET', '/api/agent/skills/pdf-report')
    expect(detail.status).toBe(200)
    expect(detail.json.builtin).toBe(true)
    const updated = await req('PUT', '/api/agent/skills/pdf-report', {
      name: 'Hacked', description: 'x', instructions: 'y',
    })
    expect(updated.status).toBe(400)
  })

  it('snapshots skill versions on edit and can revert', async () => {
    const created = await req('POST', '/api/agent/skills', {
      name: 'Versioned Skill', description: 'v1', instructions: 'First version of the instructions.',
    })
    expect(created.status).toBe(201)
    const id = created.json.id

    // Edit → snapshot of v1 must exist.
    await req('PUT', `/api/agent/skills/${id}`, { name: 'Versioned Skill', description: 'v2', instructions: 'Second version of the instructions.' })
    const versions = await req('GET', `/api/agent/skills/${id}/versions`)
    expect(versions.status).toBe(200)
    expect(versions.json.versions.length).toBe(1)

    // Revert to the snapshot → instructions restored to v1.
    const reverted = await req('POST', `/api/agent/skills/${id}/revert`, { version: versions.json.versions[0].version })
    expect(reverted.status).toBe(200)
    const after = await req('GET', `/api/agent/skills/${id}`)
    expect(after.json.instructions).toBe('First version of the instructions.')
    expect((await req('DELETE', `/api/agent/skills/${id}`)).json.ok).toBe(true)
  })

  it('installs and uninstalls a data plugin with a safe HTTP-tool manifest', async () => {
    const installed = await req('POST', '/api/agent/plugins/install', {
      id: 'test-api', name: 'Test API', description: 'probe plugin',
      tools: [{ name: 'get_items', description: 'list items', method: 'GET', url: 'https://api.example.com/items', params: [{ name: 'limit', type: 'number', description: 'max' }] }],
    })
    expect(installed.status).toBe(201)
    expect(installed.json.id).toBe('test-api')
    const list = await req('GET', '/api/agent/plugins')
    const mine = list.json.find((p: any) => p.id === 'test-api')
    expect(mine).toBeTruthy()
    expect(mine.enabled).toBe(true)
    expect(mine.tools).toContain('get_items')

    // Reserved/invalid manifests are rejected.
    expect((await req('POST', '/api/agent/plugins/install', { id: 'text-utils', name: 'x', tools: [] })).status).toBe(400)
    expect((await req('POST', '/api/agent/plugins/install', { id: 'evil<script>', name: 'x', tools: [{ name: 't', url: 'javascript:alert(1)' }] })).status).toBe(400)

    // Built-ins cannot be uninstalled; the data plugin can.
    expect((await req('DELETE', '/api/agent/plugins/text-utils')).status).toBe(400)
    expect((await req('DELETE', '/api/agent/plugins/test-api')).json.ok).toBe(true)
    expect((await req('GET', '/api/agent/plugins')).json.some((p: any) => p.id === 'test-api')).toBe(false)
  })

  it('lists plugins and toggles one', async () => {
    const list = await req('GET', '/api/agent/plugins')
    expect(list.status).toBe(200)
    const plugin = list.json.find((p: any) => p.id === 'text-utils')
    expect(plugin).toBeTruthy()
    expect(plugin.enabled).toBe(false)
    expect((await req('POST', '/api/agent/plugins/text-utils', { enabled: true })).json.enabled).toBe(true)
    expect((await req('GET', '/api/agent/plugins')).json.find((p: any) => p.id === 'text-utils').enabled).toBe(true)
    expect((await req('POST', '/api/agent/plugins/text-utils', { enabled: false })).json.enabled).toBe(false)
  })

  it('creates and removes a custom webhook tool', async () => {
    const created = await req('POST', '/api/agent/custom-tools', {
      name: 'get_weather', description: 'weather', method: 'GET', url: 'https://api.example.com/w?q={q}',
      params: [{ name: 'q', type: 'string', required: true }],
    })
    expect(created.status).toBe(201)
    expect(created.json.id).toBeTruthy()
    expect((await req('GET', '/api/agent/custom-tools')).json.some((t: any) => t.name === 'get_weather')).toBe(true)
    expect((await req('DELETE', `/api/agent/custom-tools/${created.json.id}`)).json.ok).toBe(true)
    expect((await req('GET', '/api/agent/custom-tools')).json.length).toBe(0)
  })

  it('rejects an invalid custom tool name', async () => {
    const bad = await req('POST', '/api/agent/custom-tools', { name: 'bad name', url: 'https://x.example' })
    expect(bad.status).toBe(400)
  })

  it('lists connector types and adds/removes a configured connector', async () => {
    const types = await req('GET', '/api/agent/connectors')
    expect(types.status).toBe(200)
    expect(types.json.types.some((t: any) => t.type === 'github')).toBe(true)

    const added = await req('POST', '/api/agent/connectors', { type: 'github', name: 'GitHub', config: { token: 'secret-token' } })
    expect(added.status).toBe(201)
    const list = await req('GET', '/api/agent/connectors')
    expect(list.json.configured).toHaveLength(1)
    // The secret value is never returned, only its presence.
    expect(list.json.configured[0].fields.token).toBe(true)
    expect(JSON.stringify(list.json)).not.toContain('secret-token')
    expect((await req('DELETE', `/api/agent/connectors/${added.json.id}`)).json.ok).toBe(true)
    expect((await req('GET', '/api/agent/connectors')).json.configured).toHaveLength(0)
  })

  it('rejects an unknown connector type', async () => {
    const bad = await req('POST', '/api/agent/connectors', { type: 'not-real', name: 'X' })
    expect(bad.status).toBe(400)
  })

  it('serves the marketplace separately from the available connector grid', async () => {
    const { json } = await req('GET', '/api/agent/connectors')
    // Available grid: key-based + platform OAuth (incl. Google services).
    const availableTypes = json.types.map((t: any) => t.type)
    for (const t of ['notion', 'slack', 'github', 'google_drive', 'gmail', 'google_calendar', 'google_sheets']) {
      expect(availableTypes).toContain(t)
    }
    // Marketplace entries are NOT in the default grid.
    const marketTypes = json.marketplace.map((m: any) => m.type)
    for (const t of ['outlook', 'onedrive', 'dropbox', 'linear', 'asana', 'salesforce', 'figma', 'zoom']) {
      expect(availableTypes).not.toContain(t)
      expect(marketTypes).toContain(t)
    }
    // No dead cards: every marketplace entry carries its developer-console docs.
    expect(marketTypes.length).toBe(8)
  })

  it('tests a configured connector and stores the result status', async () => {
    // Validation is disabled under test (synthetic tokens); exercise the endpoint.
    const added = await req('POST', '/api/agent/connectors', { type: 'http', name: 'Local API', config: { baseUrl: 'https://example.invalid' } })
    expect(added.status).toBe(201)
    const tested = await req('POST', `/api/agent/connectors/${added.json.id}/test`)
    expect(tested.status).toBe(200)
    expect(typeof tested.json.ok).toBe('boolean')
    const list = await req('GET', '/api/agent/connectors')
    const cfg = list.json.configured.find((c: any) => c.id === added.json.id)
    expect(cfg.lastTestedAt).toBeTruthy()
    expect(typeof cfg.lastTestOk).toBe('boolean')
    expect((await req('DELETE', `/api/agent/connectors/${added.json.id}`)).json.ok).toBe(true)
  })

  it('lists MCP servers (none configured) without erroring', async () => {
    const { status, json } = await req('GET', '/api/agent/mcp-servers')
    expect(status).toBe(200)
    expect(Array.isArray(json)).toBe(true)
  })

  it('exposes per-tool permissions with defaults and applies an override', async () => {
    const before = await req('GET', '/api/agent/permissions')
    expect(before.status).toBe(200)
    const gen = before.json.tools.find((t: any) => t.name === 'generate_image')
    expect(gen.default).toBe('approval')
    expect(gen.effective).toBe('approval')
    const web = before.json.tools.find((t: any) => t.name === 'web_search')
    expect(web.default).toBe('allow')

    expect((await req('POST', '/api/agent/permissions', { name: 'web_search', level: 'blocked' })).status).toBe(200)
    const after = await req('GET', '/api/agent/permissions')
    expect(after.json.tools.find((t: any) => t.name === 'web_search').effective).toBe('blocked')
    expect((await req('POST', '/api/agent/permissions', { name: 'web_search', level: 'nope' })).status).toBe(400)
  })

  it('returns the tool-call audit log', async () => {
    const { status, json } = await req('GET', '/api/agent/audit')
    expect(status).toBe(200)
    expect(Array.isArray(json)).toBe(true)
  })
})
