import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import ProjectDetailPage from '../project/page'

const nav = vi.hoisted(() => ({ push: vi.fn() }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: nav.push }) }))
const ws = vi.hoisted(() => ({ id: 'ws-1' as string | null }))
vi.mock('../chat/hooks', () => ({ useWorkspaceProjects: () => ({ workspaceId: ws.id, projects: [], activeProjectId: null }) }))

/** The page fetches via React Query; wrap renders with a throwaway client. */
function withQuery(node: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>)
}

const fetchMock = vi.fn()
vi.stubGlobal('fetch', fetchMock)

const PROJECTS = [{
  id: 'p1', name: 'Payments rewrite', role: 'owner', instructions: 'Use strict TypeScript.',
  createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-02T00:00:00Z',
  _count: { knowledgeChunks: 4, conversations: 2 },
}]
const CONVERSATIONS = [
  { id: 'c1', title: 'In project', updatedAt: new Date().toISOString(), projectId: 'p1' },
  { id: 'c2', title: 'Outside project', updatedAt: new Date().toISOString(), projectId: null },
]

function routeMocks() {
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    const u = String(url)
    if (u.includes('/api/workspaces/ws-1/projects') && u.endsWith('/projects')) {
      return Promise.resolve({ ok: true, json: async () => PROJECTS })
    }
    if (u.includes('/api/conversations')) {
      return Promise.resolve({ ok: true, json: async () => CONVERSATIONS })
    }
    return Promise.resolve({ ok: true, json: async () => ({}) })
  })
}

describe('/project?id= detail page (blueprint §A2.3)', () => {
  beforeEach(() => {
    window.history.replaceState(null, '', '/project?id=p1')
    fetchMock.mockReset(); routeMocks()
  })
  afterEach(() => { cleanup(); nav.push.mockClear() })

  it('renders the project header with real counts and the scoped chat list', async () => {
    withQuery(<ProjectDetailPage />)
    expect(await screen.findByRole('heading', { name: 'Payments rewrite' })).toBeInTheDocument()
    expect(screen.getByText(/2 chats/)).toBeInTheDocument()
    expect(screen.getByText(/4 indexed passages/)).toBeInTheDocument()
    // scoped: only the project's conversation appears
    expect(screen.getByText('In project')).toBeInTheDocument()
    expect(screen.queryByText('Outside project')).not.toBeInTheDocument()
    // instructions pre-filled from the project
    expect(screen.getByLabelText('Project instructions')).toHaveValue('Use strict TypeScript.')
  })

  it('saves instructions through the real PATCH shape', async () => {
    withQuery(<ProjectDetailPage />)
    await screen.findByRole('heading', { name: 'Payments rewrite' })
    const ta = screen.getByLabelText('Project instructions')
    fireEvent.change(ta, { target: { value: 'Prefer functional style.' } })
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({}) })
    fireEvent.click(screen.getByRole('button', { name: /Save/ }))
    await waitFor(() => {
      const call = fetchMock.mock.calls.find((c) => String(c[0]).includes('/projects/p1') && (c[1] as any)?.method === 'PATCH')
      expect(call).toBeTruthy()
      expect(JSON.parse((call![1] as any).body)).toEqual({ instructions: 'Prefer functional style.' })
    })
    await waitFor(() => expect(screen.getByText('Saved.')).toBeInTheDocument())
  })

  it('ingests text through the real endpoint and reports the count', async () => {
    withQuery(<ProjectDetailPage />)
    await screen.findByRole('heading', { name: 'Payments rewrite' })
    fireEvent.change(screen.getByLabelText('Add text to project knowledge'), { target: { value: 'API notes to index' } })
    fetchMock.mockImplementation((url: string) => {
      const u = String(url)
      if (u.includes('/ingest')) return Promise.resolve({ ok: true, json: async () => ({ chunks: 3 }) })
      return Promise.resolve({ ok: true, json: async () => u.includes('conversations') ? CONVERSATIONS : PROJECTS })
    })
    fireEvent.click(screen.getByRole('button', { name: /Add text/ }))
    await waitFor(() => expect(screen.getByText('Indexed 3 passages.')).toBeInTheDocument())
    const call = fetchMock.mock.calls.find((c) => String(c[0]).includes('/projects/p1/ingest'))
    expect(call).toBeTruthy()
    expect(JSON.parse((call![1] as any).body)).toEqual({ text: 'API notes to index' })
  })

  it('searches project knowledge and renders passages', async () => {
    withQuery(<ProjectDetailPage />)
    await screen.findByRole('heading', { name: 'Payments rewrite' })
    fireEvent.change(screen.getByLabelText('Search project knowledge'), { target: { value: 'refund flow' } })
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ results: [{ chunk: { content: 'The refund flow retries three times.' } }] }) })
    fireEvent.click(screen.getByRole('button', { name: /Search/ }))
    await waitFor(() => expect(screen.getByText(/The refund flow retries three times/)).toBeInTheDocument())
  })

  it('shows the honest missing state for an unknown id', async () => {
    window.history.replaceState(null, '', '/project?id=nope')
    withQuery(<ProjectDetailPage />)
    expect(await screen.findByText('That project does not exist')).toBeInTheDocument()
    expect(screen.getByText('It may have been deleted, or the link is stale.')).toBeInTheDocument()
  })

  it('links a scoped chat to the conversation', async () => {
    withQuery(<ProjectDetailPage />)
    await screen.findByRole('heading', { name: 'Payments rewrite' })
    const link = screen.getByRole('link', { name: /In project/ })
    expect(link).toHaveAttribute('href', '/chat?conversation=c1')
  })
})