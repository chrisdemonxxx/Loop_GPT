import { describe, expect, it, vi, beforeEach } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'

const listBoxFiles = vi.fn()
const deleteBoxFile = vi.fn()

vi.mock('@loop/api-client', () => ({
  listBoxFiles: (...args: unknown[]) => listBoxFiles(...args),
  readBoxFile: vi.fn(),
  writeBoxFile: vi.fn(),
  deleteBoxFile: (...args: unknown[]) => deleteBoxFile(...args),
  wakeBotComputer: vi.fn(),
  BotApiError: class BotApiError extends Error {
    status: number
    code: string
    constructor(status = 0, code = '', message = '') {
      super(message)
      this.status = status
      this.code = code
    }
  },
}))

import { BotFilesPanel } from '../BotFilesPanel'

describe('BotFilesPanel delete', () => {
  beforeEach(() => {
    listBoxFiles.mockReset()
    deleteBoxFile.mockReset()
    listBoxFiles.mockResolvedValue({
      entries: [{ name: 'notes.txt', path: '/workspace/notes.txt', type: 'file', size: 12 }],
    })
  })

  it('confirms with the app dialog instead of window.confirm', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    deleteBoxFile.mockResolvedValue({ ok: true })
    render(<BotFilesPanel />)
    const remove = await screen.findByRole('button', { name: 'Delete notes.txt' })
    expect(remove.className).not.toContain('hidden')
    fireEvent.click(remove)
    expect(confirm).not.toHaveBeenCalled()
    expect(deleteBoxFile).not.toHaveBeenCalled()
    expect(screen.getByRole('alertdialog')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect(await screen.findByText('notes.txt')).toBeTruthy()
    await vi.waitFor(() => expect(deleteBoxFile).toHaveBeenCalledWith('/workspace/notes.txt'))
    confirm.mockRestore()
  })

  it('ignores a directory listing that returns after the user has moved on', async () => {
    const pending: Array<{ dir: string; resolve: (value: unknown) => void }> = []
    listBoxFiles.mockImplementation((dir: string) => new Promise((resolve) => {
      pending.push({ dir, resolve })
    }))
    render(<BotFilesPanel />)
    await vi.waitFor(() => expect(pending.some((item) => item.dir === '/workspace')).toBe(true))
    pending.find((item) => item.dir === '/workspace')!.resolve({
      entries: [{ name: 'docs', path: '/workspace/docs', type: 'dir', size: 0 }],
    })
    fireEvent.click(await screen.findByRole('button', { name: 'docs' }))
    await vi.waitFor(() => expect(pending.some((item) => item.dir === '/workspace/docs')).toBe(true))
    fireEvent.click(screen.getByRole('button', { name: 'workspace' }))
    await vi.waitFor(() => expect(pending.filter((item) => item.dir === '/workspace').length).toBeGreaterThanOrEqual(2))

    const docsReq = pending.find((item) => item.dir === '/workspace/docs')!
    const currentRoot = pending.filter((item) => item.dir === '/workspace').at(-1)!
    await act(async () => {
      currentRoot.resolve({
        entries: [{ name: 'current.txt', path: '/workspace/current.txt', type: 'file', size: 4 }],
      })
    })
    expect(await screen.findByText('current.txt')).toBeInTheDocument()
    await act(async () => {
      docsReq.resolve({
        entries: [{ name: 'stale.txt', path: '/workspace/docs/stale.txt', type: 'file', size: 4 }],
      })
      await Promise.resolve()
    })
    expect(screen.queryByText('stale.txt')).not.toBeInTheDocument()
    expect(screen.getByText('current.txt')).toBeInTheDocument()
  })
})
