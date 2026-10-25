import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'

const deleteBoxFile = vi.fn()

vi.mock('@loop/api-client', () => ({
  listBoxFiles: vi.fn(async () => ({
    entries: [{ name: 'notes.txt', path: '/workspace/notes.txt', type: 'file', size: 12 }],
  })),
  readBoxFile: vi.fn(),
  writeBoxFile: vi.fn(),
  deleteBoxFile: (...args: unknown[]) => deleteBoxFile(...args),
  wakeBotComputer: vi.fn(),
  BotApiError: class BotApiError extends Error { status = 0; code = '' },
}))

import { BotFilesPanel } from '../BotFilesPanel'

describe('BotFilesPanel delete', () => {
  it('confirms with the app dialog instead of window.confirm', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    deleteBoxFile.mockResolvedValue({ ok: true })
    render(<BotFilesPanel />)
    const remove = await screen.findByRole('button', { name: 'Delete notes.txt', hidden: true })
    fireEvent.click(remove)
    expect(confirm).not.toHaveBeenCalled()
    expect(deleteBoxFile).not.toHaveBeenCalled()
    expect(screen.getByRole('alertdialog')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect(await screen.findByText('notes.txt')).toBeTruthy()
    await vi.waitFor(() => expect(deleteBoxFile).toHaveBeenCalledWith('/workspace/notes.txt'))
    confirm.mockRestore()
  })
})
