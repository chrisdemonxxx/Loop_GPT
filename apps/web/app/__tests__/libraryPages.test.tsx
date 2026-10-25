import { ReactNode, useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import axios from 'axios'
import { I18nProvider } from '../lib/i18n'
import ProjectsPage from '../projects/page'
import CustomizePage from '../customize/page'
import RecentsPage from '../recents/page'
import ArtifactsPage from '../artifacts/page'
import ArtifactPage from '../artifact/page'
import { conversationIdFromLocation, useConversationQuery } from '../chat/conversationSelection'

const nav = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), id: 'file-1' }))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: nav.push, replace: nav.replace }),
  useParams: () => ({ id: nav.id }),
}))

vi.mock('axios', () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
}))

const http = axios as unknown as {
  get: ReturnType<typeof vi.fn>
  post: ReturnType<typeof vi.fn>
  patch: ReturnType<typeof vi.fn>
  delete: ReturnType<typeof vi.fn>
}

const fetchMock = vi.fn()

function token() {
  const body = btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 }))
  return `h.${body}.s`
}

function withQuery(node: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <I18nProvider>{node}</I18nProvider>
    </QueryClientProvider>,
  )
}

function workspaceAxios() {
  http.post.mockResolvedValue({ data: {} })
  http.get.mockImplementation((url: string) => {
    if (String(url).endsWith('/api/workspaces')) {
      return Promise.resolve({ data: { workspaces: [{ id: 'ws-1', personalOwnerId: 'u' }] } })
    }
    return Promise.resolve({ data: [] })
  })
}

beforeEach(() => {
  nav.push.mockReset()
  nav.replace.mockReset()
  nav.id = 'file-1'
  http.get.mockReset()
  http.post.mockReset()
  http.patch.mockReset()
  http.delete.mockReset()
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {} })))
  localStorage.clear()
  window.history.pushState({}, '', '/chat')
})

function SelectionHarness() {
  const [id, setId] = useState<string | null>(null)
  useConversationQuery(id, setId)
  return (
    <>
      <span data-testid="selected">{id ?? ''}</span>
      <button type="button" onClick={() => setId('next')}>Pick next</button>
      <button type="button" onClick={() => setId(null)}>Clear selection</button>
    </>
  )
}

describe('conversation selection', () => {
  it('reads an existing id and does not create a conversation', async () => {
    expect(conversationIdFromLocation('?conversation=abc')).toBe('abc')
    expect(conversationIdFromLocation('')).toBeNull()
    window.history.pushState({}, '', '/chat?conversation=abc')
    render(<SelectionHarness />)
    expect(await screen.findByTestId('selected')).toHaveTextContent('abc')
    expect(window.location.search).toContain('conversation=abc')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(http.post).not.toHaveBeenCalled()
  })

  it('drops the query when the selection is cleared so a reload stays on a new session', async () => {
    window.history.pushState({}, '', '/chat?conversation=abc')
    const view = render(<SelectionHarness />)
    expect(await screen.findByTestId('selected')).toHaveTextContent('abc')
    fireEvent.click(screen.getByRole('button', { name: 'Clear selection' }))
    await waitFor(() => expect(window.location.search).not.toContain('conversation'))
    expect(screen.getByTestId('selected')).toHaveTextContent('')
    view.unmount()
    render(<SelectionHarness />)
    expect(screen.getByTestId('selected')).toHaveTextContent('')
    expect(window.location.search).not.toContain('abc')
  })

  it('replaces the query when a different chat is selected', async () => {
    window.history.pushState({}, '', '/chat?conversation=abc')
    const view = render(<SelectionHarness />)
    expect(await screen.findByTestId('selected')).toHaveTextContent('abc')
    fireEvent.click(screen.getByRole('button', { name: 'Pick next' }))
    await waitFor(() => expect(window.location.search).toContain('conversation=next'))
    expect(window.location.search).not.toContain('abc')
    view.unmount()
    render(<SelectionHarness />)
    expect(await screen.findByTestId('selected')).toHaveTextContent('next')
  })
})

describe('/projects', () => {
  it('does not fetch or create when the workspace is null', async () => {
    render(<ProjectsPage />)
    expect(await screen.findByRole('main', { name: 'Projects' })).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByText(/Loading/)).not.toBeInTheDocument())
    expect(fetchMock).not.toHaveBeenCalled()
    expect(http.get).not.toHaveBeenCalled()
    expect(http.post).not.toHaveBeenCalled()
    expect(screen.queryByText('No projects yet')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'New project' }))
    fireEvent.change(screen.getByLabelText('Project name'), { target: { value: 'Orphan' } })
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    fireEvent.click(screen.getByRole('button', { name: 'Create project' }))
    expect(fetchMock).not.toHaveBeenCalled()
    expect(http.post).not.toHaveBeenCalled()
  })

  it('keeps Cancel, the empty copy, the load error, and the create draft', async () => {
    localStorage.setItem('authToken', token())
    workspaceAxios()
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return Promise.resolve({ ok: false, json: async () => ({ error: 'Name taken' }) })
      return Promise.resolve({ ok: true, json: async () => [] })
    })
    render(<ProjectsPage />)
    expect(await screen.findByText('No projects yet')).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'New project' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.getByRole('button', { name: 'New project' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'New project' }))
    fireEvent.change(screen.getByLabelText('Project name'), { target: { value: 'Alpha' } })
    fireEvent.change(screen.getByLabelText('Project instructions'), { target: { value: 'Be brief' } })
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    fireEvent.click(screen.getByRole('button', { name: 'Create project' }))
    expect(await screen.findByText('Name taken')).toBeInTheDocument()
    expect(screen.getByText(/Step 2 of 2/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect((screen.getByLabelText('Project name') as HTMLInputElement).value).toBe('Alpha')
    expect((screen.getByLabelText('Project instructions') as HTMLTextAreaElement).value).toBe('Be brief')
  })

  it('a failed list is not an empty library', async () => {
    localStorage.setItem('authToken', token())
    workspaceAxios()
    fetchMock.mockResolvedValue({ ok: false, json: async () => ({ error: 'boom' }) })
    render(<ProjectsPage />)
    expect(await screen.findByText('Could not load projects.')).toBeInTheDocument()
    expect(screen.queryByText('No projects yet')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
  })
})

describe('/customize', () => {
  it('renders the same tabs as a page, not a dialog', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => [] })
    render(<CustomizePage />)
    expect(screen.getByRole('main', { name: 'Settings' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Back to Chat' })).toHaveAttribute('href', '/chat')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    const tabs = screen.getAllByRole('tab').map((tab) => tab.textContent?.replace(/[^\w]+/g, ' ').trim())
    // Reflect was merged into Memory (redesign P1).
    expect(tabs).toEqual([
      'General', 'Account', 'Privacy', 'Billing', 'Tools', 'Memory', 'Time and focus', 'Loop Code',
      'Skills', 'Connectors', 'Plugins', 'Personalization', 'Appearance',
    ])
  })
})

describe('/artifacts', () => {
  it('reads saved artifact refs once and links a row to /artifact/:id', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => [{ id: 'f1', name: 'report.md', kind: 'md', url: '/api/files/f1/content', mimeType: 'text/markdown' }],
    })
    withQuery(<ArtifactsPage />)
    const link = await screen.findByRole('link', { name: /report.md/ })
    expect(link).toHaveAttribute('href', '/artifact?id=f1')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String(fetchMock.mock.calls[0][0])).toContain('/api/conversations?artifacts=1')
  })

  it('uses the empty line only after a successful read with none', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => [] })
    withQuery(<ArtifactsPage />)
    expect(await screen.findByText('Generated files and code snippets appear here as the agent creates them.')).toBeInTheDocument()
    expect(screen.queryByText("Couldn't load files.")).not.toBeInTheDocument()
  })

  it('a failed read is not the empty library and Retry repeats the same read', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, json: async () => ({ error: 'no' }) })
    withQuery(<ArtifactsPage />)
    expect(await screen.findByText("Couldn't load files.")).toBeInTheDocument()
    expect(screen.queryByText('Generated files and code snippets appear here as the agent creates them.')).not.toBeInTheDocument()
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => [] })
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('Generated files and code snippets appear here as the agent creates them.')).toBeInTheDocument()
    expect(String(fetchMock.mock.calls.at(-1)?.[0])).toContain('/api/conversations?artifacts=1')
  })
})

describe('/artifact/:id', () => {
  it('loads the file, then the existing preview, download, and publish controls', async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if ((init?.method || 'GET') === 'POST') throw new Error('created')
      if (String(url).includes('/content')) return { ok: true, text: async () => '# hi', json: async () => ({}) }
      return {
        ok: true,
        json: async () => ({ id: 'file-1', name: 'notes.md', mimeType: 'text/markdown', size: 3, url: '/api/files/file-1/content' }),
      }
    })
    window.history.pushState({}, '', '/artifact/?id=file-1')
    withQuery(<ArtifactPage />)
    expect(await screen.findByText('notes.md')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Preview' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Download' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Publish link' })).toBeInTheDocument()
    expect(fetchMock.mock.calls.some((call) => (call[1] as RequestInit | undefined)?.method === 'POST')).toBe(false)
  })

  it('a missing file is not the empty library and Retry refetches that file', async () => {
    fetchMock.mockResolvedValue({ ok: false, json: async () => ({ error: 'missing' }) })
    window.history.pushState({}, '', '/artifact/?id=file-1')
    withQuery(<ArtifactPage />)
    expect(await screen.findByText("Couldn't open this file.")).toBeInTheDocument()
    expect(screen.queryByText('Generated files and code snippets appear here as the agent creates them.')).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Back to files' })).toHaveAttribute('href', '/artifacts')
    const before = fetchMock.mock.calls.length
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(before))
    const urls = fetchMock.mock.calls.map((call) => String(call[0]))
    expect(urls.every((url) => url.includes('/api/files/file-1'))).toBe(true)
    expect(fetchMock.mock.calls.some((call) => (call[1] as RequestInit | undefined)?.method === 'POST')).toBe(false)
  })
})

describe('/recents', () => {
  it('redirects to chat', async () => {
    withQuery(<RecentsPage />)
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith('/chat'))
  })
})
