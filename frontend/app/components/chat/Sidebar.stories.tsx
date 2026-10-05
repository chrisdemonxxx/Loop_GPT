import React from 'react'
import type { Meta, StoryObj } from '@storybook/react'
import Sidebar, { type ConversationSearchHit } from './Sidebar'
import type { Conversation } from './types'

const now = Date.now()
const iso = (minsAgo: number) => new Date(now - minsAgo * 60_000).toISOString()

const conversations: Conversation[] = [
  { id: 'c1', title: 'Vector DB trade-offs for RAG', createdAt: iso(4), updatedAt: iso(4), pinned: true },
  { id: 'c2', title: 'Rewrite the deploy runbook', createdAt: iso(30), updatedAt: iso(30) },
  { id: 'c3', title: 'Stripe webhook retries', createdAt: iso(26 * 60), updatedAt: iso(26 * 60) },
  { id: 'c4', title: 'Landing copy — hero', createdAt: iso(3 * 24 * 60), updatedAt: iso(3 * 24 * 60) },
]

const projects = [
  { id: 'p1', name: 'Launch', _count: { knowledgeChunks: 12, conversations: 3 } },
  { id: 'p2', name: 'Research', _count: { knowledgeChunks: 4, conversations: 1 } },
]

const messageHits: ConversationSearchHit[] = [
  {
    conversationId: 'c3',
    title: 'Stripe webhook retries',
    updatedAt: iso(26 * 60),
    pinned: false,
    snippet: '…the retry backoff should cap at 30s with jitter…',
    matches: 2,
  },
]

const noop = () => {}

const meta = {
  title: 'Chat/Sidebar',
  component: Sidebar,
  parameters: { layout: 'fullscreen' },
  decorators: [
    (Story: () => React.ReactElement) =>
      React.createElement(
        'div',
        { style: { width: 300, height: '100vh', background: '#0b0b12' } },
        React.createElement(Story),
      ),
  ],
  args: {
    conversations,
    currentConversationId: 'c1',
    user: { name: 'Chris', email: 'chris@loop-gpt.cyou', plan: 'pro', role: 'admin' },
    projects,
    activeProjectId: null,
    onSelectConversation: noop,
    onClose: noop,
    onOpenSettings: noop,
    onLogout: noop,
    onRenameConversation: noop,
    onDeleteConversation: noop,
    onPinConversation: noop,
    onShareConversation: async () => null,
    searchQuery: '',
    onSearchChange: noop,
    messageHits: [],
    onOpenProjects: noop,
    onSelectProject: noop,
    activeProjectName: undefined,
  },
} satisfies Meta<typeof Sidebar>

export default meta
type Story = StoryObj<typeof meta>

/** Populated history: pinned row + date buckets. */
export const Default: Story = {}

/** No conversations yet — the first-run empty copy. */
export const Empty: Story = { args: { conversations: [], currentConversationId: null } }

/** A search that matched titles, including the body-only "Matching messages" group. */
export const SearchResults: Story = {
  args: { searchQuery: 'stripe', messageHits },
}

/** A search with no title or body match — the empty-results copy. */
export const SearchEmpty: Story = { args: { searchQuery: 'zzz-no-match' } }

/** User menu open — settings / account / developer / admin / sign-out. */
export const UserMenuOpen: Story = {
  play: async ({ canvasElement }) => {
    const { userEvent, within } = await import('@storybook/test')
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByText('Chris'))
  },
}

/** No projects on the account — the "Create a project" affordance. */
export const NoProjects: Story = { args: { projects: [] } }
