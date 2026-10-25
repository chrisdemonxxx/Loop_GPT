import type { ReactNode } from 'react'
import { act, render, renderHook, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const client = vi.hoisted(() => ({
  startRun: vi.fn(),
  getMe: vi.fn(),
}))

vi.mock('@loop/loopit-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@loop/loopit-client')>()),
  startRun: client.startRun,
  getMe: client.getMe,
}))

const nav = vi.hoisted(() => ({ params: new URLSearchParams('run=run_a') }))

vi.mock('next/navigation', () => ({
  useSearchParams: () => nav.params,
  useRouter: () => ({ push: vi.fn() }),
  useParams: () => ({}),
}))

const mounts = vi.hoisted(() => ({ count: 0 }))

vi.mock('../[runId]/RunView', async () => {
  const React = await import('react')
  return {
    // Remembers the run it mounted with: showing a new id proves a remount,
    // not a prop change on a component still holding the old run's state.
    default: function FakeRunView({ runId }: { runId: string }) {
      const [mountedWith] = React.useState(() => {
        mounts.count += 1
        return runId
      })
      return <p data-testid="run">{mountedWith}</p>
    },
  }
})

import BuildPage from '../page'
import { useStartBuild, useTerminalAccess } from '../hooks'

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
}

beforeEach(() => {
  client.startRun.mockReset()
  client.getMe.mockReset()
  client.startRun.mockResolvedValue({ run_id: 'run_new', project_id: 'proj_1', status: 'queued' })
  mounts.count = 0
})

describe('useStartBuild', () => {
  it('continues the given project instead of starting a new one', async () => {
    const { result } = renderHook(() => useStartBuild(), { wrapper })
    await act(async () => { await result.current.mutateAsync({ prompt: 'again', projectId: 'proj_1' }) })
    expect(client.startRun).toHaveBeenCalledWith('again', { projectId: 'proj_1' })
  })

  it('starts a new project when there is none', async () => {
    const { result } = renderHook(() => useStartBuild(), { wrapper })
    await act(async () => { await result.current.mutateAsync({ prompt: 'fresh' }) })
    expect(client.startRun).toHaveBeenCalledWith('fresh', {})
  })
})

describe('useTerminalAccess', () => {
  it('is granted only by the build:terminal scope', async () => {
    client.getMe.mockResolvedValue({ user_id: 'u', email: null, org_id: 'o', role: 'owner', scopes: ['api', 'runs'] })
    const member = renderHook(() => useTerminalAccess(), { wrapper })
    await waitFor(() => expect(client.getMe).toHaveBeenCalled())
    expect(member.result.current).toBe(false)

    client.getMe.mockResolvedValue({ user_id: 'u', email: null, org_id: 'o', role: 'owner', scopes: ['api', 'runs', 'build:terminal'] })
    const admin = renderHook(() => useTerminalAccess(), { wrapper })
    await waitFor(() => expect(admin.result.current).toBe(true))
  })
})

describe('BuildPage', () => {
  it('remounts the run view when switching builds', () => {
    nav.params = new URLSearchParams('run=run_a')
    const view = render(<BuildPage />, { wrapper })
    expect(screen.getByTestId('run').textContent).toBe('run_a')

    nav.params = new URLSearchParams('run=run_b')
    view.rerender(<BuildPage />)
    expect(screen.getByTestId('run').textContent).toBe('run_b')
    expect(mounts.count).toBe(2)
  })

  it('seeds the composer from ?prompt=', () => {
    nav.params = new URLSearchParams('prompt=Build%20a%20landing%20page')
    render(<BuildPage />, { wrapper })
    expect(screen.getByRole('textbox')).toHaveValue('Build a landing page')
  })

  it('describes chat mode as a new run', async () => {
    nav.params = new URLSearchParams()
    const user = userEvent.setup()
    render(<BuildPage />, { wrapper })
    await user.click(screen.getByRole('button', { name: 'Chat' }))
    expect(screen.getByPlaceholderText(/new read-only run/i)).toBeInTheDocument()
    expect(screen.queryByPlaceholderText(/existing project/i)).toBeNull()
  })
})
