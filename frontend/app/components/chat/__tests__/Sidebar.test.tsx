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

function renderSidebar(overrides: Partial<typeof base> = {}) {
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
