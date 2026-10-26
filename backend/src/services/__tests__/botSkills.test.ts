import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let dir = ''

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-skill-'))
  vi.stubEnv('AGENT_SKILLS_DIR', path.join(dir, 'skills'))
  vi.stubEnv('AGENT_DATA_DIR', path.join(dir, 'data'))
  vi.resetModules()
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
  vi.unstubAllEnvs()
})

describe('bot skill routes', () => {
  it('creates and updates a skill through the skill loader and returns the source', async () => {
    const { postBotSkill, putBotSkill } = await import('../botSkills')
    const created = postBotSkill('user-1', {
      name: 'Invoice export',
      description: 'Pull the CSV from billing',
      instructions: '# Steps\n\nOpen billing.',
      triggers: ['invoice'],
    })
    expect(created.status).toBe(201)
    expect(created.body.instructions).toContain('Open billing')
    const updated = putBotSkill('user-1', created.body.id, {
      name: 'Invoice export',
      description: 'When a billing CSV is needed',
      instructions: '# Steps\n\nDownload the CSV.',
    })
    expect(updated.status).toBe(200)
    expect(updated.body.description).toBe('When a billing CSV is needed')
    expect(updated.body.instructions).toContain('Download the CSV')
  })
})
