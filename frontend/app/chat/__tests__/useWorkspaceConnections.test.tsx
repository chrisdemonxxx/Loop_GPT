import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

// Axios mock: GET /api/workspaces/:id/connections returns the list.
const axiosGet = vi.hoisted(() => vi.fn())
vi.mock('axios', async (original) => ({ ...(await original<typeof import('axios')>()), default: { get: axiosGet } }))
import { useWorkspaceConnections } from '../hooks'

/** Workspace-connection chips (Â§8-40): list, pin-for-next-run, recent use. */

const CONNECTIONS = [
  { id: 'conn-a', name: 'Acme CRM', type: 'http' },
  { id: 'conn-b', name: 'Billing API', type: 'http' },
]

const wrapper = ({ children }: { children: React.ReactNode }) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

beforeEach(() => {
  window.localStorage.clear()
  axiosGet.mockReset().mockResolvedValue({ data: { connections: CONNECTIONS } })
})
afterEach(() => window.localStorage.clear())

describe('useWorkspaceConnections (Â§8-40)', () => {
  it('lists connections and pins one for the next run', async () => {
    const { result } = renderHook(() => useWorkspaceConnections('ws-1'), { wrapper })
    await waitFor(() => expect(result.current.connections).toHaveLength(2))
    expect(result.current.pinnedId).toBeNull()
    act(() => result.current.togglePin('conn-a'))
    expect(result.current.pinnedId).toBe('conn-a')
    // Pinning persists per workspace.
    expect(window.localStorage.getItem('pinned-connection:ws-1')).toBe('conn-a')
    // Toggling the same chip unpins.
    act(() => result.current.togglePin('conn-a'))
    expect(result.current.pinnedId).toBeNull()
  })

  it('orders chips recent-use-first after a run uses a connection', async () => {
    const { result } = renderHook(() => useWorkspaceConnections('ws-1'), { wrapper })
    await waitFor(() => expect(result.current.connections).toHaveLength(2))
    expect(result.current.connections.map((c) => c.id)).toEqual(['conn-a', 'conn-b'])
    act(() => result.current.markUsed(['conn-b']))
    expect(result.current.connections.map((c) => c.id)).toEqual(['conn-b', 'conn-a'])
    // Recency persists.
    expect(JSON.parse(window.localStorage.getItem('recent-connections:ws-1') || '[]')).toEqual(['conn-b'])
  })

  it('drops recency entries for connections that no longer exist', async () => {
    window.localStorage.setItem('recent-connections:ws-1', JSON.stringify(['gone', 'conn-b']))
    const { result } = renderHook(() => useWorkspaceConnections('ws-1'), { wrapper })
    await waitFor(() => expect(result.current.connections).toHaveLength(2))
    // The stale id vanishes; the surviving recency still orders first.
    expect(result.current.connections.map((c) => c.id)).toEqual(['conn-b', 'conn-a'])
  })

  it('normalizes a malformed API payload to an empty list', async () => {
    axiosGet.mockResolvedValue({ data: 'proxy error page' })
    const { result } = renderHook(() => useWorkspaceConnections('ws-1'), { wrapper })
    await waitFor(() => expect(result.current.connections).toEqual([]))
  })

  it('stays empty without a workspace', () => {
    const { result } = renderHook(() => useWorkspaceConnections(null), { wrapper })
    expect(result.current.connections).toEqual([])
    expect(axiosGet).not.toHaveBeenCalled()
  })
})
