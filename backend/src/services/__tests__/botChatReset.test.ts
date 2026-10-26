import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { addBotMemory, readBotMemory } from '../botMemory'
import { attachmentPreface, inboxPath, resetChatCursor, visibleChatTasks } from '../botChat'

describe('bot chat reset and attachments', () => {
  let tmp = ''
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-chat-'))
    process.env.BOT_MEMORY_DIR = path.join(tmp, 'mem')
    process.env.BOT_CHAT_DIR = path.join(tmp, 'chat')
  })
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
    delete process.env.BOT_MEMORY_DIR
    delete process.env.BOT_CHAT_DIR
  })

  it('hides the thread after reset and leaves memory in place', () => {
    addBotMemory('u1', 'b1', 'Keep this')
    const cursor = resetChatCursor('u1', 'b1', new Date('2026-10-25T12:00:00.000Z'))
    const visible = visibleChatTasks([
      { id: 'old', kind: 'ops', createdAt: '2026-10-25T11:00:00.000Z' },
      { id: 'routine', kind: 'scheduled', createdAt: '2026-10-25T11:00:00.000Z' },
      { id: 'new', kind: 'ops', createdAt: '2026-10-25T12:01:00.000Z' },
    ], cursor)
    expect(visible.map((task) => task.id)).toEqual(['routine', 'new'])
    expect(readBotMemory('u1', 'b1')).toContain('Keep this')
  })

  it('places a dropped file in the inbox and names it in the run', () => {
    expect(inboxPath('quarterly report.pdf')).toBe('/workspace/inbox/quarterly report.pdf')
    expect(() => inboxPath('../secret')).toThrow(/inbox/)
    expect(attachmentPreface([{ name: 'quarterly report.pdf', path: '/workspace/inbox/quarterly report.pdf' }])).toContain('quarterly report.pdf')
  })
})
