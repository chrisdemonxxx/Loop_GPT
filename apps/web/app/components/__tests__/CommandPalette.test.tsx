import { useState, type ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { CommandPalette, openSidebarSearch } from '../CommandPalette'

// Exit motion never finishes in jsdom, so a closed palette would stay mounted.
vi.mock('framer-motion', () => {
  const React = require('react')
  type MockDivProps = {
    children?: ReactNode
    initial?: unknown
    animate?: unknown
    exit?: unknown
    transition?: unknown
  }
  const Div = ({ children, initial, animate, exit, transition, ...rest }: MockDivProps) =>
    React.createElement('div', rest, children)
  return {
    AnimatePresence: ({ children }: { children?: ReactNode }) => children,
    motion: { div: Div },
  }
})

function openPalette() {
  fireEvent.keyDown(document.body, { key: 'k', metaKey: true })
}

function Harness({ initialOpen = false }: { initialOpen?: boolean }) {
  const [open, setOpen] = useState(initialOpen)
  return (
    <>
      <aside aria-label="Sidebar">
        <input aria-label="Search chats…" />
      </aside>
      <span data-testid="sidebar-open">{String(open)}</span>
      <CommandPalette
        onNewSession={vi.fn()}
        onOpenSettings={vi.fn()}
        onLogout={vi.fn()}
        onToggleSidebar={() => setOpen((value) => !value)}
        onSearchChats={() => openSidebarSearch(setOpen)}
      />
    </>
  )
}

afterEach(() => vi.unstubAllGlobals())

describe('CommandPalette', () => {
  it('keeps the five commands, runs the first match on Enter, and does not fetch', () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const onLogout = vi.fn()
    render(
      <CommandPalette
        onNewSession={vi.fn()}
        onToggleSidebar={vi.fn()}
        onSearchChats={vi.fn()}
        onOpenSettings={vi.fn()}
        onLogout={onLogout}
      />,
    )
    openPalette()
    for (const label of ['New session', 'Search chats', 'Toggle sidebar', 'Settings', 'Sign out']) {
      expect(screen.getByText(label)).toBeInTheDocument()
    }
    const input = screen.getByPlaceholderText(/Type a command/)
    fireEvent.change(input, { target: { value: 'sign' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onLogout).toHaveBeenCalledOnce()
    expect(screen.queryByPlaceholderText(/Type a command/)).not.toBeInTheDocument()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('says No matching commands when nothing matches', () => {
    render(
      <CommandPalette
        onNewSession={vi.fn()}
        onToggleSidebar={vi.fn()}
        onSearchChats={vi.fn()}
        onOpenSettings={vi.fn()}
        onLogout={vi.fn()}
      />,
    )
    openPalette()
    fireEvent.change(screen.getByPlaceholderText(/Type a command/), { target: { value: 'zzzz' } })
    expect(screen.getByText('No matching commands.')).toBeInTheDocument()
  })

  it('Search chats opens a closed sidebar and focuses search without closing an open one', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    render(<Harness />)
    expect(screen.getByTestId('sidebar-open')).toHaveTextContent('false')
    openPalette()
    fireEvent.click(screen.getByRole('button', { name: 'Search chats' }))
    await waitFor(() => expect(screen.getByTestId('sidebar-open')).toHaveTextContent('true'))
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Search chats…')))
    openPalette()
    fireEvent.click(screen.getByRole('button', { name: 'Search chats' }))
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Search chats…')))
    expect(screen.getByTestId('sidebar-open')).toHaveTextContent('true')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('Toggle sidebar stays a toggle', () => {
    render(<Harness />)
    openPalette()
    fireEvent.click(screen.getByRole('button', { name: 'Toggle sidebar' }))
    expect(screen.getByTestId('sidebar-open')).toHaveTextContent('true')
    openPalette()
    fireEvent.click(screen.getByRole('button', { name: 'Toggle sidebar' }))
    expect(screen.getByTestId('sidebar-open')).toHaveTextContent('false')
  })
})
