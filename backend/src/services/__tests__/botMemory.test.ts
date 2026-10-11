import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

// Point the mirror store at a temp dir before the module loads.
let tmp = ''
process.env.AGENT_DATA_DIR = ''

import { BOT_MEMORY_CAP_CHARS, appendBotMemory, botMemoryPromptSection, readBotMemory } from '../../services/botMemory'

describe('botMemory mirror', () => {
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-mem-'))
    process.env.BOT_MEMORY_DIR = path.join(tmp, 'mem')
  })

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
    delete process.env.BOT_MEMORY_DIR
  })

  it('reads back appended notes with dates', () => {
    expect(readBotMemory('u1', 'b1')).toBe('')
    expect(appendBotMemory('u1', 'b1', 'Acme only signs annual plans')).toBe(true)
    expect(appendBotMemory('u1', 'b1', 'Dana approves them')).toBe(true)
    const memory = readBotMemory('u1', 'b1')
    expect(memory).toContain('Acme only signs annual plans')
    expect(memory).toContain('Dana approves them')
    expect(memory.split('\n')).toHaveLength(2)
  })

  it('scopes memory to the owner and the bot', () => {
    appendBotMemory('u1', 'b1', 'for u1/b1 only')
    expect(readBotMemory('u1', 'b2')).toBe('')
    expect(readBotMemory('u2', 'b1')).toBe('')
    expect(readBotMemory('u1', 'b1')).toContain('for u1/b1 only')
  })

  it('refuses unsafe ids instead of traversing', () => {
    expect(appendBotMemory('../x', 'b1', 'nope')).toBe(false)
    expect(appendBotMemory('u1', '..', 'nope')).toBe(false)
    expect(readBotMemory('u1', '..')).toBe('')
  })

  it('trims the head when the file passes the cap', () => {
    for (let i = 0; i < 200; i += 1) appendBotMemory('u1', 'b1', `note ${i} ${'x'.repeat(20)}`)
    const memory = readBotMemory('u1', 'b1')
    expect(memory.length).toBeLessThanOrEqual(BOT_MEMORY_CAP_CHARS + 200)
    expect(memory).toContain('note 199')
    expect(memory).not.toContain('note 0 ')
  })

  it('composes the prompt section only when memory exists', () => {
    expect(botMemoryPromptSection('u1', 'b1')).toBe('')
    appendBotMemory('u1', 'b1', 'remember me')
    const section = botMemoryPromptSection('u1', 'b1')
    expect(section).toContain('BOT MEMORY')
    expect(section).toContain('remember me')
  })
})
