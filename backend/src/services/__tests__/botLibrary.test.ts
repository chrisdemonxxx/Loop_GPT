import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { artifactAction, catalogLibraryItem, listLibrary, mintShare, readShare, revokeShare } from '../botLibrary'

describe('bot library', () => {
  let tmp = ''
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-lib-'))
    process.env.BOT_LIBRARY_DIR = path.join(tmp, 'lib')
  })
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
    delete process.env.BOT_LIBRARY_DIR
  })

  it('catalogs pages, files, and apps, and a share link can be revoked', () => {
    const page = catalogLibraryItem('u1', { botId: 'b1', kind: 'page', name: 'Launch', path: '/workspace/sites/launch/index.html' })
    catalogLibraryItem('u1', { botId: 'b1', kind: 'file', name: 'Notes', path: '/workspace/exports/notes.md' })
    catalogLibraryItem('u1', { botId: 'b1', kind: 'app', name: 'Board', path: '/workspace/sites/board/index.html' })
    expect(listLibrary('u1', 'b1').map((item) => item.kind).sort()).toEqual(['app', 'file', 'page'])
    expect(() => catalogLibraryItem('u1', { botId: 'b1', kind: 'file', name: 'Escape', path: '/workspace/../etc/passwd' })).toThrow(/workspace/)

    const share = mintShare('u1', page.id, new Date('2026-10-25T00:00:00.000Z'))
    expect(readShare(share.token, new Date('2026-10-25T01:00:00.000Z'))?.name).toBe('Launch')
    expect(revokeShare('u1', page.id)).toBe(true)
    expect(readShare(share.token, new Date('2026-10-25T01:00:00.000Z'))).toBeNull()
  })

  it('treats docx as download-only', () => {
    expect(artifactAction('brief.docx')).toBe('download')
    expect(artifactAction('sheet.xlsx')).toBe('view')
    expect(artifactAction('notes.md')).toBe('view')
  })
})
