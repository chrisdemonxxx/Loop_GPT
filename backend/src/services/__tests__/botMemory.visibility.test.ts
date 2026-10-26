import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  addBotMemory,
  botMemoryPromptSection,
  deleteBotMemory,
  listBotMemories,
  memoriesForViewer,
  memoryForRun,
} from '../botMemory'

describe('structured bot memory', () => {
  let tmp = ''
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-mem-'))
    process.env.BOT_MEMORY_DIR = path.join(tmp, 'mem')
  })
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
    delete process.env.BOT_MEMORY_DIR
  })

  it('adds, lists, and deletes memories, private by default', () => {
    const added = addBotMemory('owner', 'bot', 'Ships on Fridays')
    expect(added?.visibility).toBe('private')
    const team = addBotMemory('owner', 'bot', 'Shared standup note', 'team')
    expect(listBotMemories('owner', 'bot').map((row) => row.content)).toEqual(['Ships on Fridays', 'Shared standup note'])
    expect(deleteBotMemory('owner', 'bot', added!.id)).toBe(true)
    expect(listBotMemories('owner', 'bot').map((row) => row.id)).toEqual([team!.id])
  })

  it('stores team memory and lets only the owner read it', () => {
    addBotMemory('owner', 'bot', 'Team note', 'team')
    expect(memoriesForViewer('owner', 'bot', 'owner').status).toBe(200)
    expect(memoriesForViewer('owner', 'bot', 'teammate')).toEqual({ status: 403, memories: [] })
    expect(botMemoryPromptSection('owner', 'bot')).toContain('Team note')
  })

  it('does not merge another bot memory into a group task', () => {
    addBotMemory('owner', 'helm', 'Helm knows the deploy window')
    addBotMemory('owner', 'review', 'Review knows the rubric')
    const section = memoryForRun('owner', 'helm', ['helm', 'review'])
    expect(section).toContain('Helm knows the deploy window')
    expect(section).not.toContain('Review knows the rubric')
  })
})
