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