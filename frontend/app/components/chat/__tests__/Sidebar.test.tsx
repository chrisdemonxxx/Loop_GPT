import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import Sidebar, { type ConversationSearchHit } from '../Sidebar'
import type { Conversation } from '../types'

/** Sidebar parity (audit §8-13..16): date-grouped history, pin float + star,
 * share copy affordance, and message-body search results with snippets. */

const iso = (dayOffset: number) => {
  const d = new Date()
  d.setDate(d.getDate() - dayOffset)
  return d.toISOString()
}

const conv = (id: string, title: string, dayOffset: number, pinned = false): Conversation => ({
  id, title, createdAt: iso(dayOffset), updatedAt: iso(dayOffset), pinned,
})

const base = {
  conversations: [] as Conversation[],
  currentConversationId: null,
  user: { name: 'Tester', plan: 'free' },
  projects: [],
  activeProjectId: null,
  onSelectConversation: vi.fn(),
  onClose: vi.fn(),
  onOpenSettings: vi.fn(),
  onLogout: vi.fn(),
  onRenameConversation: vi.fn(),
  onDeleteConversation: vi.fn(),
  onPinConversation: vi.fn(),
  onShareConversation: vi.fn(async () => 'https://loop-gpt.cyou/share/abc'),
  searchQuery: '',
  onSearchChange: vi.fn(),
  messageHits: [] as ConversationSearchHit[],
  onOpenProjects: vi.fn(),
  onSelectProject: vi.fn(),
}

import { I18nProvider } from '../../../lib/i18n'

function renderSidebar(overrides: Partial<React.ComponentProps<typeof Sidebar>> = {}) {
  const props = { ...base, ...overrides }
  return render(<I18nProvider><Sidebar {...props} /></I18nProvider>)
}

beforeEach(() => {
  Object.values(base).forEach((v) => { if (typeof v === 'function' && 'mockClear' in (v as any)) (v as any).mockClear() })
})

const GROUPED = [
  conv('old', 'Ancient chat', 30),
  conv('today', 'Fresh chat', 0),
  conv('pinned', 'Keep me', 10, true),
  conv('yday', 'Yesterday chat', 1),
]

describe('Sidebar — grouped history', () => {
  it('groups conversations by date bucket with pinned floating first', () => {
    const { container } = renderSidebar({ conversations: GROUPED })
    const headers = [...container.querySelectorAll('.uppercase.tracking-widest')].map((h) => h.textContent)
    expect(headers).toEqual(['Pinned', 'Today', 'Yesterday', 'Older'])
    // Pinned row renders a star even outside hover.
    expect(screen.getByLabelText('Pinned')).toBeInTheDocument()
  })

  it('dispatches pin toggles from the row action', () => {
    renderSidebar({ conversations: [conv('c1', 'Chat', 0)] })
    fireEvent.click(screen.getByTitle('Pin to top'))
    expect(base.onPinConversation).toHaveBeenCalledWith('c1', true)
  })
})

describe('Sidebar — share', () => {
  it('copies the minted link and confirms visually', async () => {
    renderSidebar({ conversations: [conv('c1', 'Chat', 0)] })
    fireEvent.click(screen.getByTitle('Share public link'))
    await screen.findByTitle('Link copied')
    expect(base.onShareConversation).toHaveBeenCalledWith('c1')
  })

  it('says the share failed and does not claim the link was copied', async () => {
    renderSidebar({
      conversations: [conv('c1', 'Chat', 0)],
      onShareConversation: vi.fn(async () => ({ error: 'share' as const })),
    })
    fireEvent.click(screen.getByTitle('Share public link'))
    expect(await screen.findByText("Couldn't share this session.")).toBeInTheDocument()
    expect(screen.queryByTitle('Link copied')).not.toBeInTheDocument()
    expect(screen.queryByText('No matching commands.')).not.toBeInTheDocument()
    expect(screen.queryByText('No sessions yet.')).not.toBeInTheDocument()
    expect(screen.getByText('Chat')).toBeInTheDocument()
  })

  it('says the copy failed after a link exists and does not claim it was copied', async () => {
    renderSidebar({
      conversations: [conv('c1', 'Chat', 0)],
      onShareConversation: vi.fn(async () => ({ error: 'copy' as const })),
    })
    fireEvent.click(screen.getByTitle('Share public link'))
    expect(await screen.findByText("Couldn't copy the link.")).toBeInTheDocument()
    expect(screen.queryByTitle('Link copied')).not.toBeInTheDocument()
    expect(screen.getByText('Chat')).toBeInTheDocument()
  })
})

describe('Sidebar — message-body search', () => {
  it('renders server hits with snippets when the title does not match', () => {
    renderSidebar({
      conversations: [conv('c1', 'Boring title', 0)],
      searchQuery: 'zebra',
      messageHits: [
        { conversationId: 'c2', title: 'Other chat', updatedAt: iso(0), pinned: false, snippet: '…the zebra runs…', matches: 2 },
      ],
    })
    expect(screen.getByText('Matching messages')).toBeInTheDocument()
    expect(screen.getByText('…the zebra runs…')).toBeInTheDocument()
    expect(screen.getByText('2×')).toBeInTheDocument()
    fireEvent.click(screen.getByText('Other chat').closest('button') as HTMLElement)
    expect(base.onSelectConversation).toHaveBeenCalledWith('c2')
  })

  it('shows the no-match message for a query with zero hits', () => {
    renderSidebar({ conversations: [], searchQuery: 'nope' })
    expect(screen.getByText(/No chats match "nope"/)).toBeInTheDocument()
  })
})

describe('Sidebar ? recents copy and failures', () => {
  it('keeps buckets in order including Previous 7 days', () => {
    const { container } = renderSidebar({
      conversations: [
        conv('old', 'Ancient chat', 30),
        conv('week', 'Last week', 3),
        conv('today', 'Fresh chat', 0),
        conv('pinned', 'Keep me', 10, true),
        conv('yday', 'Yesterday chat', 1),
      ],
    })
    const headers = [...container.querySelectorAll('.uppercase.tracking-widest')].map((h) => h.textContent)
    expect(headers).toEqual(['Pinned', 'Today', 'Yesterday', 'Previous 7 days', 'Older'])
  })

  it('says No sessions yet when the loaded list is empty', () => {
    renderSidebar({ conversations: [] })
    expect(screen.getByText('No sessions yet.')).toBeInTheDocument()
  })

  it('a failed load is not the empty list and Retry calls back', () => {
    const onRetrySessions = vi.fn()
    renderSidebar({ conversations: [], sessionsError: true, onRetrySessions })
    expect(screen.getByText("Couldn't load sessions.")).toBeInTheDocument()
    expect(screen.queryByText('No sessions yet.')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(onRetrySessions).toHaveBeenCalledOnce()
  })

  it('keeps the shown list when a later load failed', () => {
    renderSidebar({
      conversations: [conv('c1', 'Fresh chat', 0)],
      sessionsError: true,
    })
    expect(screen.getByText('Fresh chat')).toBeInTheDocument()
    expect(screen.queryByText('No sessions yet.')).not.toBeInTheDocument()
    expect(screen.queryByText("Couldn't load sessions.")).not.toBeInTheDocument()
  })

  it('a failed search is not a no-match and keeps the loaded list', () => {
    const onRetrySearch = vi.fn()
    renderSidebar({
      conversations: [conv('c1', 'Fresh chat', 0)],
      searchQuery: 'nope',
      searchError: true,
      onRetrySearch,
    })
    expect(screen.getByText("Couldn't search chats.")).toBeInTheDocument()
    expect(screen.queryByText(/No chats match/)).not.toBeInTheDocument()
    expect(screen.getByText('Fresh chat')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(onRetrySearch).toHaveBeenCalledOnce()
  })

  it('keeps the edited title when rename fails', async () => {
    const onRenameConversation = vi.fn(async () => false as const)
    renderSidebar({ conversations: [conv('c1', 'Chat', 0)], onRenameConversation })
    fireEvent.click(screen.getByTitle('Rename'))
    fireEvent.change(screen.getByDisplayValue('Chat'), { target: { value: 'Better title' } })
    fireEvent.blur(screen.getByDisplayValue('Better title'))
    expect(await screen.findByDisplayValue('Better title')).toBeInTheDocument()
    expect(onRenameConversation).toHaveBeenCalledWith('c1', 'Better title')
  })

  it('asks before delete and leaves the session when cancelled', () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    renderSidebar({ conversations: [conv('c1', 'Chat', 0)], currentConversationId: 'c1' })
    fireEvent.click(screen.getByTitle('Delete'))
    expect(confirm).toHaveBeenCalledWith('Delete this session?')
    expect(base.onDeleteConversation).not.toHaveBeenCalled()
    expect(screen.getByText('Chat')).toBeInTheDocument()
    confirm.mockRestore()
  })
})

describe('Sidebar workspace links', () => {
  it('points Projects, Files, Recents, and Customize at their routes', () => {
    renderSidebar()
    expect(screen.getByRole('link', { name: 'Projects' })).toHaveAttribute('href', '/projects')
    expect(screen.getByRole('link', { name: 'Files' })).toHaveAttribute('href', '/artifacts')
    expect(screen.getByRole('link', { name: 'Recents' })).toHaveAttribute('href', '/recents')
    expect(screen.getByRole('link', { name: 'Customize' })).toHaveAttribute('href', '/customize')
    expect(screen.getByRole('button', { name: /Projects/ })).toBeInTheDocument()
  })
})

