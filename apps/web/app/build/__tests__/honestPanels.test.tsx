import type { ReactNode } from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const client = vi.hoisted(() => ({
  getHealth: vi.fn(),
  getMe: vi.fn(),
  getGitStatus: vi.fn(),
  bindGitRemote: vi.fn(),
  pushGitCheckpoint: vi.fn(),
  pullGitWebhook: vi.fn(),
  listProjectDomains: vi.fn(),
  verifyProjectDomain: vi.fn(),
  claimProjectDomain: vi.fn(),
  heartbeatProjectPresence: vi.fn(),
  getProjectCollab: vi.fn(),
  getSecurityScan: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn() }),
  useParams: () => ({}),
  usePathname: () => '/build/projects',
}))

vi.mock('@loop/loopit-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@loop/loopit-client')>()),
  getHealth: client.getHealth,
  getMe: client.getMe,
  getGitStatus: client.getGitStatus,
  bindGitRemote: client.bindGitRemote,
  pushGitCheckpoint: client.pushGitCheckpoint,
  pullGitWebhook: client.pullGitWebhook,
  listProjectDomains: client.listProjectDomains,
  verifyProjectDomain: client.verifyProjectDomain,
  claimProjectDomain: client.claimProjectDomain,
  heartbeatProjectPresence: client.heartbeatProjectPresence,
  getProjectCollab: client.getProjectCollab,
  getSecurityScan: client.getSecurityScan,
}))

import { CollaborationPanel } from '../Phase3Panels'
import { SecurityPanel } from '../Phase2Panels'
import { ProjectDomainsPanel, ProjectGitPanel } from '../projects/page'

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
}

const healthBase = {
  status: 'ok',
  offline: false,
  exec_enabled: false,
  projects_root: '/',
  run_execution_mode: 'local',
}

beforeEach(() => {
  for (const fn of Object.values(client)) fn.mockReset()
  client.getMe.mockResolvedValue({ user_id: 'u', email: null, org_id: 'o', role: 'owner', scopes: [] })
  client.getHealth.mockResolvedValue({ ...healthBase, gitsync_provider: 'fake', domains_mode: 'fake' })
  client.getGitStatus.mockResolvedValue({ bound: false, mode: 'fake' })
  client.listProjectDomains.mockResolvedValue([])
  client.heartbeatProjectPresence.mockResolvedValue({
    project_id: 'proj_1',
    online_count: 0,
    presence: [],
    messages: [],
  })
  client.getSecurityScan.mockResolvedValue({ findings: [], passed: false, mode: 'offline', stub: true })
})

describe('GitHub sync honesty', () => {
  it('stays disconnected when the provider is fake', async () => {
    client.getGitStatus.mockRejectedValue(new Error('status failed'))
    render(<ProjectGitPanel projectId="proj_1" />, { wrapper })
    expect(await screen.findByText('GitHub sync is not connected.')).toBeInTheDocument()
    expect(screen.queryByText(/status failed/)).toBeNull()
  })

  it('shows a failed status fetch when a real provider is connected', async () => {
    client.getHealth.mockResolvedValue({ ...healthBase, gitsync_provider: 'github' })
    client.getGitStatus.mockRejectedValue(new Error('status failed'))
    render(<ProjectGitPanel projectId="proj_1" />, { wrapper })
    expect(await screen.findByRole('alert')).toHaveTextContent(/status failed/)
    expect(screen.queryByText('GitHub sync is not connected.')).toBeNull()
  })

  it('pushes and pulls through the client and shows their errors', async () => {
    const user = userEvent.setup()
    client.getHealth.mockResolvedValue({ ...healthBase, gitsync_provider: 'github' })
    client.getGitStatus.mockResolvedValue({ bound: true, mode: 'github', owner: 'acme', name: 'demo' })
    client.pushGitCheckpoint.mockRejectedValue(new Error('push rejected'))
    client.pullGitWebhook.mockRejectedValue(new Error('pull rejected'))
    render(<ProjectGitPanel projectId="proj_1" checkpointId="cp_1" />, { wrapper })
    await user.click(await screen.findByRole('button', { name: 'Push' }))
    expect(client.pushGitCheckpoint).toHaveBeenCalledWith('proj_1', 'cp_1')
    expect(await screen.findByText(/push rejected/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Pull' }))
    expect(client.pullGitWebhook).toHaveBeenCalledWith('proj_1', {})
    expect(await screen.findByText(/pull rejected/)).toBeInTheDocument()
  })
})

describe('custom domains honesty', () => {
  const claim = {
    claim_id: 'c1',
    hostname: 'app.example.test',
    status: 'pending',
    challenge_name: '_loopit-verify.app.example.test',
    challenge_value: 'tok',
    expires_at: '2099-01-01T00:00:00Z',
    project_id: 'proj_1',
  }

  it('does not offer Verify when the resolver is the in-memory fake', async () => {
    client.listProjectDomains.mockResolvedValue([claim])
    render(<ProjectDomainsPanel projectId="proj_1" />, { wrapper })
    expect(await screen.findByText('Custom domains are not connected')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Verify' })).toBeNull()
  })

  it('verifies without seeding when a real resolver is configured', async () => {
    const user = userEvent.setup()
    client.getHealth.mockResolvedValue({ ...healthBase, domains_mode: 'live', domains_configured: true })
    client.listProjectDomains.mockResolvedValue([claim])
    client.verifyProjectDomain.mockResolvedValue({ ...claim, status: 'verified' })
    render(<ProjectDomainsPanel projectId="proj_1" />, { wrapper })
    await user.click(await screen.findByRole('button', { name: 'Verify' }))
    expect(client.verifyProjectDomain).toHaveBeenCalledWith('proj_1', 'app.example.test', false)
  })
})

describe('collaboration honesty', () => {
  it('reads Just you when the only heartbeat is the current user', async () => {
    client.heartbeatProjectPresence.mockResolvedValue({
      project_id: 'proj_1',
      online_count: 1,
      presence: [{ actor_id: 'u', display_name: 'Ada', role: 'owner' }],
      messages: [],
    })
    render(<CollaborationPanel projectId="proj_1" />, { wrapper })
    await waitFor(() => {
      expect(client.getMe).toHaveBeenCalled()
      expect(client.heartbeatProjectPresence).toHaveBeenCalled()
    })
    await waitFor(() => {
      expect(screen.queryByText(/1 online/)).toBeNull()
      expect(screen.getByText('Just you')).toBeInTheDocument()
    })
  })

  it('shows a heartbeat error instead of an empty note list', async () => {
    client.heartbeatProjectPresence.mockRejectedValue(new Error('presence failed'))
    client.getProjectCollab.mockRejectedValue(new Error('presence failed'))
    render(<CollaborationPanel projectId="proj_1" />, { wrapper })
    expect(await screen.findByRole('alert')).toHaveTextContent(/presence failed/)
    expect(screen.queryByText('No notes yet.')).toBeNull()
  })
})

describe('security load errors', () => {
  it('shows a scan load failure instead of an empty pass', async () => {
    client.getSecurityScan.mockRejectedValue(new Error('scan store unavailable'))
    render(<SecurityPanel projectId="proj_1" />, { wrapper })
    expect(await screen.findByRole('alert')).toHaveTextContent(/scan store unavailable/)
    expect(screen.queryByText('Passed')).toBeNull()
    expect(screen.queryByText('No findings yet.')).toBeNull()
    expect(screen.getByRole('button', { name: 'Scan now' })).toBeDisabled()
  })
})
