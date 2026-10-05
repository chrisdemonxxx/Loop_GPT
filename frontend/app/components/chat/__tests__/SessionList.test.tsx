import { useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import axios from 'axios'
import Sidebar from '../Sidebar'
import { I18nProvider } from '../../../lib/i18n'
import { useConversationsData, useConversationSearch } from '../../../chat/hooks'

vi.mock('axios', () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
}))

const http = axios as unknown as { get: ReturnType<typeof vi.fn>; patch: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> }

const sessionRow = {
  id: 'c1',
  title: 'Fresh chat',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  pinned: false,
}

function Harness({ search = '', currentId = null as string | null, onDeleted = vi.fn() }) {
  const [client] = useState(() => new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  }))
  return (
    <QueryClientProvider client={client}>
      <Sessions search={search} currentId={currentId} onDeleted={onDeleted} />
    </QueryClientProvider>
  )
}

function Sessions({ search, currentId, onDeleted }: { search: string; currentId: string | null; onDeleted: (id: string) => void }) {
  const data = useConversationsData(currentId, onDeleted)
  const found = useConversationSearch(search)
  return (
    <I18nProvider>
      <button type="button" onClick={data.retrySessions}>Reload sessions</button>
      <Sidebar
        conversations={data.conversations}
        currentConversationId={currentId}
        user={{ name: 'Tester' }}
        projects={[]}
        activeProjectId={null}
        onSelectConversation={vi.fn()}
        onClose={vi.fn()}
        onOpenSettings={vi.fn()}
        onLogout={vi.fn()}
        onRenameConversation={async (id, title) => {
          try { await data.updateConv.mutateAsync({ id, title }) } catch { return false }
        }}
        onDeleteConversation={(id) => data.deleteConv.mutate(id)}
        onPinConversation={vi.fn()}
        onShareConversation={vi.fn(async () => null)}
        searchQuery={search}
        onSearchChange={vi.fn()}
        messageHits={found.hits}
        sessionsError={data.sessionsError}
        sessionsPending={data.sessionsPending}
        onRetrySessions={data.retrySessions}
        searchError={found.error}
        onRetrySearch={found.retry}
        onOpenProjects={vi.fn()}
        onSelectProject={vi.fn()}
      />
    </I18nProvider>
  )
}

beforeEach(() => {
  http.get.mockReset()
  http.patch.mockReset()
  http.delete.mockReset()
})

describe('session list fetch', () => {
  it.each([
    ['network', () => Promise.reject(new Error('offline'))],
    ['non-OK', () => Promise.reject(Object.assign(new Error('bad'), { response: { status: 500 } }))],
    ['non-array', () => Promise.resolve({ data: { error: 'page' } })],
  ])('a %s failure is not an empty list and Retry refetches GET /api/conversations', async (_name, respond) => {
    http.get.mockImplementation(respond)
    render(<Harness />)
    expect(await screen.findByText("Couldn't load sessions.")).toBeInTheDocument()
    expect(screen.queryByText('No sessions yet.')).not.toBeInTheDocument()
    const url = String(http.get.mock.calls[0][0])
    expect(url).toContain('/api/conversations')
    expect(url).not.toContain('/search')
    http.get.mockResolvedValueOnce({ data: [sessionRow] })
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('Fresh chat')).toBeInTheDocument()
    const again = String(http.get.mock.calls.at(-1)?.[0])
    expect(again).toBe(url)
  })

  it('keeps the shown list when a later refetch fails', async () => {
    http.get.mockResolvedValueOnce({ data: [sessionRow] })
    render(<Harness />)
    expect(await screen.findByText('Fresh chat')).toBeInTheDocument()
    http.get.mockRejectedValueOnce(new Error('offline'))
    fireEvent.click(screen.getByRole('button', { name: 'Reload sessions' }))
    await waitFor(() => expect(http.get.mock.calls.length).toBeGreaterThan(1))
    expect(screen.getByText('Fresh chat')).toBeInTheDocument()
    expect(screen.queryByText('No sessions yet.')).not.toBeInTheDocument()
  })

  it('a failed search is not No chats match and keeps the loaded list', async () => {
    http.get.mockImplementation((url: string) => {
      if (String(url).includes('/search')) return Promise.reject(new Error('search'))
      return Promise.resolve({ data: [sessionRow] })
    })
    render(<Harness search="nope" />)
    expect(await screen.findByText('Fresh chat')).toBeInTheDocument()
    expect(await screen.findByText("Couldn't search chats.")).toBeInTheDocument()
    expect(screen.queryByText(/No chats match/)).not.toBeInTheDocument()
    const before = http.get.mock.calls.filter((call) => String(call[0]).includes('/search')).length
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => {
      const searches = http.get.mock.calls.filter((call) => String(call[0]).includes('/search'))
      expect(searches.length).toBeGreaterThan(before)
      expect(searches.at(-1)?.[1]).toEqual(expect.objectContaining({ params: { q: 'nope' } }))
    })
    expect(screen.getByText('Fresh chat')).toBeInTheDocument()
  })

  it('a successful empty load and a successful no-match search keep their copy', async () => {
    http.get.mockImplementation((url: string) => {
      if (String(url).includes('/search')) return Promise.resolve({ data: [] })
      return Promise.resolve({ data: [] })
    })
    const view = render(<Harness />)
    expect(await screen.findByText('No sessions yet.')).toBeInTheDocument()
    view.rerender(<Harness search="nope" />)
    expect(await screen.findByText('No chats match "nope"')).toBeInTheDocument()
    expect(screen.queryByText("Couldn't search chats.")).not.toBeInTheDocument()
    expect(screen.queryByText("Couldn't load sessions.")).not.toBeInTheDocument()
  })

  it('a failed delete asks first and does not drop the open session', async () => {
    const onDeleted = vi.fn()
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    http.get.mockImplementation((url: string) => {
      if (String(url).includes('/messages')) return Promise.resolve({ data: { activeLeafId: null, messages: [] } })
      return Promise.resolve({ data: [sessionRow] })
    })
    http.delete.mockRejectedValue(new Error('no'))
    render(<Harness currentId="c1" onDeleted={onDeleted} />)
    expect(await screen.findByText('Fresh chat')).toBeInTheDocument()
    fireEvent.click(screen.getByTitle('Delete'))
    expect(confirm).toHaveBeenCalledWith('Delete this session?')
    await waitFor(() => expect(http.delete).toHaveBeenCalled())
    expect(onDeleted).not.toHaveBeenCalled()
    expect(screen.getByText('Fresh chat')).toBeInTheDocument()
    confirm.mockRestore()
  })

  it('shows a loading state instead of the empty copy while the first GET is pending', async () => {
    let settle: (value: { data: never[] }) => void = () => {}
    http.get.mockImplementation(() => new Promise((resolve) => { settle = resolve }))
    render(<Harness />)
    expect(await screen.findByText(/Loading/)).toBeInTheDocument()
    expect(screen.queryByText('No sessions yet.')).not.toBeInTheDocument()
    expect(screen.queryByText("Couldn't load sessions.")).not.toBeInTheDocument()
    await act(async () => { settle({ data: [] }) })
    expect(await screen.findByText('No sessions yet.')).toBeInTheDocument()
    expect(screen.queryByText(/Loading/)).not.toBeInTheDocument()
  })

  it('keeps No sessions yet when a refetch fails after a successful empty list', async () => {
    let rejectReload: (error: Error) => void = () => {}
    let calls = 0
    http.get.mockImplementation(() => {
      calls += 1
      if (calls === 1) return Promise.resolve({ data: [] })
      return new Promise((_resolve, reject) => { rejectReload = reject })
    })
    render(<Harness />)
    expect(await screen.findByText('No sessions yet.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Reload sessions' }))
    await waitFor(() => expect(calls).toBeGreaterThan(1))
    await act(async () => { rejectReload(new Error('offline')) })
    expect(screen.getByText('No sessions yet.')).toBeInTheDocument()
    expect(screen.queryByText("Couldn't load sessions.")).not.toBeInTheDocument()
  })
})
