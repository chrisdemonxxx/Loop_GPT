import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import DirectoryPage from '../customize/connectors/all/page'

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: nav.push }) }))
const nav = vi.hoisted(() => ({ push: vi.fn() }))
const ws = vi.hoisted(() => ({ id: 'ws-1' as string | null }))
vi.mock('../chat/hooks', () => ({ useWorkspaceProjects: () => ({ workspaceId: ws.id }) }))

const fetchMock = vi.fn()
vi.stubGlobal('fetch', fetchMock)
afterEach(() => { cleanup(); fetchMock.mockReset(); nav.push.mockClear() })
beforeEach(() => { window.history.replaceState(null, '', '/customize/connectors/all') })

const CATALOG = {
  types: [
    { type: 'notion', name: 'Notion', description: 'Search pages and databases in your Notion workspace.', category: 'Productivity', icon: null, oauth: false, fields: [{ key: 'token', label: 'Integration token', secret: true }], tools: [{ suffix: 'search', description: '[Notion] Search pages and databases.' }], docs: 'https://developers.notion.com' },
    { type: 'slack', name: 'Slack', description: 'Send messages and list channels.', category: 'Communication', icon: null, oauth: false, fields: [{ key: 'token', label: 'Bot token', secret: true }], tools: [{ suffix: 'post_message', description: '[Slack] Post a message.' }, { suffix: 'list_channels', description: '[Slack] List channels.' }], docs: null },
    { type: 'github', name: 'GitHub', description: 'Repos, issues and PRs.', category: 'Code', icon: null, oauth: true, fields: [], tools: [], docs: 'https://docs.github.com' },
  ],
  configured: [{ id: 'c1', type: 'slack', name: 'Slack', enabled: true, account: 'acme', lastTestedAt: null, lastTestOk: null }],
  marketplace: [],
}

function json(body: unknown) {
  return { ok: true, json: async () => body }
}

describe('connector directory (S3, CONTRACT_S3_CONNECTORS)', () => {
  it('renders every catalog card with category badges and the connect affordance', async () => {
    fetchMock.mockResolvedValue(json(CATALOG))
    render(<DirectoryPage />)
    expect(await screen.findByText('Notion')).toBeInTheDocument()
    expect(screen.getByText('Slack')).toBeInTheDocument()
    expect(screen.getByText('GitHub')).toBeInTheDocument()
    // connectState: slack configured → Connected; notion → Connect; github (oauth) → Sign in
    expect(screen.getByRole('button', { name: /Connected/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Connect$/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Sign in/ })).toBeInTheDocument()
    // tool count chip on cards is the real catalog number
    expect(screen.getByText('2')).toBeInTheDocument()
  })

  it('search and category filter narrow the grid', async () => {
    fetchMock.mockResolvedValue(json(CATALOG))
    render(<DirectoryPage />)
    await screen.findByText('Notion')
    fireEvent.change(screen.getByLabelText('Search connectors'), { target: { value: 'slack' } })
    expect(screen.getByText('Slack')).toBeInTheDocument()
    expect(screen.queryByText('Notion')).not.toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Search connectors'), { target: { value: '' } })
    fireEvent.change(screen.getByLabelText('Filter by category'), { target: { value: 'Code' } })
    expect(screen.getByText('GitHub')).toBeInTheDocument()
    expect(screen.queryByText('Slack')).not.toBeInTheDocument()
  })

  it('opens the detail view from ?type= with the Tools region and related connectors', async () => {
    window.history.replaceState(null, '', '/customize/connectors/all?type=notion')
    fetchMock.mockResolvedValue(json(CATALOG))
    render(<DirectoryPage />)
    expect(await screen.findByRole('heading', { name: 'Notion' })).toBeInTheDocument()
    const tools = screen.getByRole('region', { name: 'Tools' })
    expect(tools).toHaveTextContent('notion__search')
    expect(tools).toHaveTextContent('[Notion] Search pages and databases.')
    // facts: auth style + docs link
    expect(screen.getByText('API credential')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /developer docs/ })).toHaveAttribute('href', 'https://developers.notion.com')
    // no related in the same category → honest copy
    expect(screen.getByRole('region', { name: 'Related connectors' })).toHaveTextContent(/No other connectors/)
  })

  it('shows the honest empty state for an unknown ?type=', async () => {
    window.history.replaceState(null, '', '/customize/connectors/all?type=teleport')
    fetchMock.mockResolvedValue(json(CATALOG))
    render(<DirectoryPage />)
    expect(await screen.findByText('That connector does not exist')).toBeInTheDocument()
    expect(screen.getByText(/No directory entry matches type "teleport"/)).toBeInTheDocument()
  })

  it('saves credentials with the same request shape as the Connectors tab', async () => {
    window.history.replaceState(null, '', '/customize/connectors/all?type=notion')
    fetchMock.mockResolvedValue(json(CATALOG))
    render(<DirectoryPage />)
    await screen.findByRole('heading', { name: 'Notion' })
    fireEvent.change(screen.getByLabelText('Integration token'), { target: { value: 'secret-token' } })
    fetchMock.mockResolvedValueOnce(json({ id: 'c2' }))
    fireEvent.click(screen.getByRole('button', { name: /Connect$/ }))
    await waitFor(() => {
      const call = fetchMock.mock.calls.find((c) => String(c[0]).includes('/api/agent/connectors') && (c[1] as any)?.method === 'POST')
      expect(call).toBeTruthy()
      expect(JSON.parse((call![1] as any).body)).toMatchObject({ type: 'notion', name: 'Notion', config: { token: 'secret-token' }, enabled: true })
    })
  })

  it("OAuth sign-in without a workspace shows the tab's gate sentence", async () => {
    const prev = ws.id
    ws.id = null
    try {
      window.history.replaceState(null, '', '/customize/connectors/all?type=github')
      fetchMock.mockResolvedValue(json(CATALOG))
      render(<DirectoryPage />)
      fireEvent.click(await screen.findByRole('button', { name: /Connect GitHub with OAuth/ }))
      await waitFor(() => expect(screen.getByText('Open a project first (Projects in the sidebar), then connect.')).toBeInTheDocument())
      const oauthCalls = fetchMock.mock.calls.filter((c) => String(c[0]).includes('oauth-connector'))
      expect(oauthCalls).toHaveLength(0)
    } finally {
      ws.id = prev
    }
  })

  it('a failed load offers Retry and never renders cards', async () => {
    fetchMock.mockRejectedValue(new Error('offline'))
    render(<DirectoryPage />)
    expect(await screen.findByText('Could not load the connector directory.')).toBeInTheDocument()
    expect(screen.queryByText('Notion')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
  })
})