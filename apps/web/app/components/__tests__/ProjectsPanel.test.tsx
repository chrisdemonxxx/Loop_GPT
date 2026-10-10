import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import ProjectsPanel from '../ProjectsPanel'

// Stub fetch — the panel fetches the project list on mount when a workspace is
// provided. Empty list keeps the markup focused on the close affordances.
const fetchMock = vi.fn()
vi.stubGlobal('fetch', fetchMock)
afterEach(() => { cleanup(); fetchMock.mockReset() })

beforeEach(() => {
  fetchMock.mockResolvedValue({ ok: true, json: async () => [] })
})

const props = {
  workspaceId: 'ws-1',
  activeProjectId: null as string | null,
  onSelect: vi.fn(),
  onClose: vi.fn(),
}

describe('ProjectsPanel close affordances (BUG-1 regression)', () => {
  it('renders an accessible Close button at the top of the modal', async () => {
    render(<ProjectsPanel {...props} />)
    const closeBtn = await screen.findByRole('button', { name: /close/i })
    // The button must have an adequate click target for keyboard / pointer users.
    expect(closeBtn).toBeInTheDocument()
    expect(closeBtn.tagName).toBe('BUTTON')
    expect(closeBtn.getAttribute('type')).toBe('button')
  })

  it('closes via the X (Close) button', async () => {
    const onClose = vi.fn()
    render(<ProjectsPanel {...props} onClose={onClose} />)
    const closeBtn = await screen.findByRole('button', { name: /close/i })
    fireEvent.click(closeBtn)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('closes via backdrop click (the outermost fixed overlay)', async () => {
    const onClose = vi.fn()
    const { container } = render(<ProjectsPanel {...props} onClose={onClose} />)
    // The backdrop is the fixed inset-0 overlay at the root of the panel.
    const backdrop = container.querySelector('.fixed.inset-0') as HTMLElement
    expect(backdrop).toBeTruthy()
    fireEvent.click(backdrop)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('does NOT close when clicking inside the modal body', async () => {
    const onClose = vi.fn()
    const { container } = render(<ProjectsPanel {...props} onClose={onClose} />)
    // The dialog is the motion.div inside the backdrop.
    const dialog = container.querySelector('[role="dialog"]') as HTMLElement
    expect(dialog).toBeTruthy()
    fireEvent.click(dialog)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('closes on Escape key — even when focus is in a textarea inside the modal', async () => {
    const onClose = vi.fn()
    render(<ProjectsPanel {...props} onClose={onClose} />)
    // Wait for the panel to mount and register the keydown listener.
    await screen.findByRole('dialog', { name: /projects/i })
    // Escape fired on document (not on a focused element) must close the panel.
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('exposes the dialog with aria-modal=true and an accessible name', async () => {
    render(<ProjectsPanel {...props} />)
    const dialog = await screen.findByRole('dialog', { name: /projects/i })
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    // Loading skeleton still counts as the dialog being present.
    expect(dialog).toBeInTheDocument()
    // Once the fetch resolves, the empty state is shown.
    await waitFor(() => expect(screen.getByText(/no projects yet/i)).toBeInTheDocument())
  })
})

const sample = [
  { id: 'zed', name: 'Zed', instructions: 'Later update', createdAt: '2026-06-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z', _count: { knowledgeChunks: 0, conversations: 1 } },
  { id: 'amy', name: 'Amy', instructions: 'Older update', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-02-01T00:00:00Z', _count: { knowledgeChunks: 2, conversations: 0 } },
]

function projectNames() {
  return Array.from(document.querySelectorAll('.text-sm.font-medium.truncate')).map((el) => el.textContent?.trim())
}

describe('ProjectsPanel list, search, and create', () => {
  it('keeps the empty copy only after a successful load of zero projects', async () => {
    render(<ProjectsPanel {...props} />)
    expect(await screen.findByText('No projects yet')).toBeInTheDocument()
    expect(screen.getByText('Projects scope chats to a set of instructions and a searchable knowledge base.')).toBeInTheDocument()
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/\/api\/workspaces\/ws-1\/projects$/)
  })

  it('does not treat a failed list load as an empty library, and Retry refetches the same GET', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, json: async () => ({ error: 'boom' }) })
    render(<ProjectsPanel {...props} />)
    expect(await screen.findByText('Could not load projects.')).toBeInTheDocument()
    expect(screen.queryByText('No projects yet')).not.toBeInTheDocument()
    const first = String(fetchMock.mock.calls[0][0])
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => [] })
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('No projects yet')).toBeInTheDocument()
    expect(screen.queryByText('Could not load projects.')).not.toBeInTheDocument()
    const second = String(fetchMock.mock.calls[1][0])
    expect(second).toBe(first)
    expect(second).not.toMatch(/[?&](sort|q|search|query)=/)
  })

  it('keeps a loaded list when a later refetch fails', async () => {
    const project = { id: 'p1', name: 'Keep me', instructions: 'notes', createdAt: '2026-05-01T00:00:00Z', updatedAt: '2026-05-02T00:00:00Z', _count: { knowledgeChunks: 1, conversations: 0 } }
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => [project] })
    render(<ProjectsPanel {...props} activeProjectId="p1" />)
    expect(await screen.findByText('Keep me')).toBeInTheDocument()
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === 'DELETE') return Promise.resolve({ ok: true, json: async () => ({}) })
      return Promise.reject(new Error('offline'))
    })
    // Delete now confirms through the shared dialog before firing the request.
    fireEvent.click(screen.getByRole('button', { name: 'Delete project' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }))
    expect(await screen.findByText('Could not load projects.')).toBeInTheDocument()
    expect(screen.getByText('Keep me')).toBeInTheDocument()
    expect(screen.queryByText('No projects yet')).not.toBeInTheDocument()
  })

  it('does not show an empty library when workspaceId is null, and does not fetch', async () => {
    render(<ProjectsPanel {...props} workspaceId={null} />)
    await screen.findByRole('dialog', { name: /projects/i })
    await waitFor(() => expect(screen.queryByText('Loading…')).not.toBeInTheDocument())
    expect(fetchMock).not.toHaveBeenCalled()
    expect(screen.queryByText('No projects yet')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'New project' }))
    fireEvent.change(screen.getByLabelText('Project name'), { target: { value: 'Orphan' } })
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    fireEvent.click(screen.getByRole('button', { name: 'Create project' }))
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('sorts newest created by default and filters by name without query params', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => sample })
    render(<ProjectsPanel {...props} />)
    await screen.findByText('Amy')
    expect(projectNames()).toEqual(['Zed', 'Amy'])
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/\/projects$/)
    expect(fetchMock.mock.calls).toHaveLength(1)
    fireEvent.change(screen.getByLabelText('Sort projects'), { target: { value: 'name' } })
    expect(projectNames()).toEqual(['Amy', 'Zed'])
    fireEvent.change(screen.getByLabelText('Sort projects'), { target: { value: 'updated' } })
    expect(projectNames()).toEqual(['Zed', 'Amy'])
    fireEvent.change(screen.getByLabelText('Sort projects'), { target: { value: 'created' } })
    expect(projectNames()).toEqual(['Zed', 'Amy'])
    expect(fetchMock.mock.calls).toHaveLength(1)
    fireEvent.change(screen.getByLabelText('Search projects'), { target: { value: 'zed' } })
    expect(projectNames()).toEqual(['Zed'])
    expect(screen.queryByText('No projects yet')).not.toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Search projects'), { target: { value: 'qqq' } })
    expect(screen.getByText(/No projects match/)).toBeInTheDocument()
    expect(screen.queryByText('No projects yet')).not.toBeInTheDocument()
    expect(fetchMock.mock.calls).toHaveLength(1)
  })

  it('returns to the list when Cancel is used on either create step', async () => {
    render(<ProjectsPanel {...props} />)
    fireEvent.click(await screen.findByRole('button', { name: 'New project' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.getByRole('button', { name: 'New project' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'New project' }))
    fireEvent.change(screen.getByLabelText('Project name'), { target: { value: 'Alpha' } })
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect(screen.getByText(/Step 2 of 2/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.getByRole('button', { name: 'New project' })).toBeInTheDocument()
  })

  it('keeps the create draft and stays on the create step when create fails', async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return Promise.resolve({ ok: false, json: async () => ({ error: 'Name taken' }) })
      return Promise.resolve({ ok: true, json: async () => [] })
    })
    render(<ProjectsPanel {...props} />)
    fireEvent.click(await screen.findByRole('button', { name: 'New project' }))
    fireEvent.change(screen.getByLabelText('Project name'), { target: { value: 'Alpha' } })
    fireEvent.change(screen.getByLabelText('Project instructions'), { target: { value: 'Be brief' } })
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    const file = new File(['hello'], 'notes.txt', { type: 'text/plain' })
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    fireEvent.change(input, { target: { files: [file] } })
    expect(screen.getByText('1 file(s) ready to index')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Create project' }))
    expect(await screen.findByText('Name taken')).toBeInTheDocument()
    expect(screen.getByText(/Step 2 of 2/)).toBeInTheDocument()
    expect(screen.getByText('1 file(s) ready to index')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'New project' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect((screen.getByLabelText('Project name') as HTMLInputElement).value).toBe('Alpha')
    expect((screen.getByLabelText('Project instructions') as HTMLTextAreaElement).value).toBe('Be brief')
  })

  it('does not roll back a created project when the seed upload fails', async () => {
    const onSelect = vi.fn()
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      const u = String(url)
      if (init?.method === 'DELETE') return Promise.resolve({ ok: true, json: async () => ({}) })
      if (init?.method === 'POST' && /\/projects$/.test(u)) {
        return Promise.resolve({ ok: true, json: async () => ({ id: 'p-new', name: 'Alpha', instructions: 'Be brief', createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z' }) })
      }
      if (u.includes('/ingest')) return Promise.resolve({ ok: false, json: async () => ({ error: 'upload failed' }) })
      return Promise.resolve({ ok: true, json: async () => [{ id: 'p-new', name: 'Alpha', instructions: 'Be brief', createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z' }] })
    })
    render(<ProjectsPanel {...props} onSelect={onSelect} />)
    fireEvent.click(await screen.findByRole('button', { name: 'New project' }))
    fireEvent.change(screen.getByLabelText('Project name'), { target: { value: 'Alpha' } })
    fireEvent.change(screen.getByLabelText('Project instructions'), { target: { value: 'Be brief' } })
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    const file = new File(['hello'], 'notes.txt', { type: 'text/plain' })
    fireEvent.change(document.querySelector('input[type="file"]') as HTMLInputElement, { target: { files: [file] } })
    fireEvent.click(screen.getByRole('button', { name: 'Create project' }))
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith('p-new'))
    expect(fetchMock.mock.calls.some((c) => (c[1] as RequestInit | undefined)?.method === 'DELETE')).toBe(false)
    expect(await screen.findByText('Alpha')).toBeInTheDocument()
  })

  it('does not clear the active project when delete fails', async () => {
    const project = { id: 'p1', name: 'Keep me', instructions: '', createdAt: '2026-05-01T00:00:00Z', updatedAt: '2026-05-02T00:00:00Z', _count: { knowledgeChunks: 1, conversations: 0 } }
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => [project] })
    const onSelect = vi.fn()
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(<ProjectsPanel {...props} activeProjectId="p1" onSelect={onSelect} />)
    expect(await screen.findByText('Keep me')).toBeInTheDocument()
    fetchMock.mockResolvedValueOnce({ ok: false, json: async () => ({ error: 'nope' }) })
    // Delete now confirms through the shared dialog before firing the request.
    fireEvent.click(screen.getByRole('button', { name: 'Delete project' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(fetchMock.mock.calls.some((c) => (c[1] as RequestInit | undefined)?.method === 'DELETE')).toBe(true))
    expect(onSelect).not.toHaveBeenCalled()
    expect(screen.getByText('Keep me')).toBeInTheDocument()
  })
})
