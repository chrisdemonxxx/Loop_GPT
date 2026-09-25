import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ShortcutSheet } from '../ShortcutSheet'

afterEach(() => cleanup())

describe('ShortcutSheet (BUG-5 regression)', () => {
  it('renders nothing when uncontrolled and closed (default state)', () => {
    render(<ShortcutSheet />)
    expect(screen.queryByText(/keyboard shortcuts/i)).not.toBeInTheDocument()
  })

  it('opens via the controlled `open` prop and closes when the prop flips back', async () => {
    const { rerender } = render(<ShortcutSheet open={false} onOpenChange={() => {}} />)
    expect(screen.queryByText(/keyboard shortcuts/i)).not.toBeInTheDocument()

    rerender(<ShortcutSheet open={true} onOpenChange={() => {}} />)
    expect(screen.getByText(/keyboard shortcuts/i)).toBeInTheDocument()
    expect(screen.getByText(/command palette/i)).toBeInTheDocument()
    expect(screen.getByText(/send message/i)).toBeInTheDocument()

    // Framer-motion keeps the exiting element mounted for the exit animation
    // (≈120ms); wait for it to actually unmount before asserting.
    rerender(<ShortcutSheet open={false} onOpenChange={() => {}} />)
    await waitFor(() => expect(screen.queryByText(/keyboard shortcuts/i)).not.toBeInTheDocument())
  })

  it('invokes onOpenChange(false) when the backdrop is clicked (controlled)', () => {
    const onOpenChange = vi.fn()
    const { container } = render(<ShortcutSheet open={true} onOpenChange={onOpenChange} />)
    const backdrop = container.querySelector('.fixed.inset-0') as HTMLElement
    expect(backdrop).toBeTruthy()
    fireEvent.click(backdrop)
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('does not close when clicking inside the sheet body (controlled)', () => {
    const onOpenChange = vi.fn()
    render(<ShortcutSheet open={true} onOpenChange={onOpenChange} />)
    fireEvent.click(screen.getByText(/command palette/i))
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
  })

  it('shows every documented shortcut entry', () => {
    const { container } = render(<ShortcutSheet open={true} onOpenChange={() => {}} />)
    for (const label of [
      'Command palette', 'New conversation', 'Toggle sidebar',
      'Send message', 'Conversation history', 'Close popover / Cancel',
      'Commands (in chat box)',
    ]) {
      expect(container.textContent).toContain(label)
    }
  })

  it('Escape on document closes an uncontrolled sheet (uses the bundled `?` key path)', async () => {
    render(<ShortcutSheet />)
    fireEvent.keyDown(window, { key: '?' })
    await waitFor(() => expect(screen.getByText(/keyboard shortcuts/i)).toBeInTheDocument())
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByText(/keyboard shortcuts/i)).not.toBeInTheDocument())
  })
})