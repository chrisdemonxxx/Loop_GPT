import type { ReactNode } from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { githubSyncConnected } from '../githubSync'
import { unifiedLineDiff } from '../lineDiff'
import { runConversationId } from '../runLink'

const client = vi.hoisted(() => ({
  listProjects: vi.fn(),
  listRuns: vi.fn(),
  listNotifications: vi.fn(),
  listReviews: vi.fn(),
  archiveProject: vi.fn(),
  restoreProject: vi.fn(),
  getProjectAnalytics: vi.fn(),
  seedProjectAnalytics: vi.fn(),
  listProjectConnectors: vi.fn(),
  setProjectConnector: vi.fn(),
  getSecurityScan: vi.fn(),
  runSecurityScan: vi.fn(),
  listBrowserTests: vi.fn(),
  startBrowserTest: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn() }),
  useParams: () => ({}),
  usePathname: () => '/build/projects',
}))

vi.mock('@loop/loopit-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@loop/loopit-client')>()),
  listProjects: client.listProjects,
  listRuns: client.listRuns,
  listNotifications: client.listNotifications,
  listReviews: client.listReviews,
  archiveProject: client.archiveProject,
  restoreProject: client.restoreProject,
  getProjectAnalytics: client.getProjectAnalytics,
  seedProjectAnalytics: client.seedProjectAnalytics,
  listProjectConnectors: client.listProjectConnectors,
  setProjectConnector: client.setProjectConnector,
  getSecurityScan: client.getSecurityScan,
  runSecurityScan: client.runSecurityScan,
  listBrowserTests: client.listBrowserTests,
  startBrowserTest: client.startBrowserTest,
}))

import BuildProjectsPage from '../projects/page'
import { AnalyticsPanel, ConnectorsPanel } from '../Phase3Panels'
import { BrowserTestsPanel, SecurityPanel } from '../Phase2Panels'

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
}

beforeEach(() => {
  client.listProjects.mockReset()
  client.listRuns.mockReset()
  client.listNotifications.mockReset()
  client.listReviews.mockReset()
  client.archiveProject.mockReset()
  client.restoreProject.mockReset()
  client.getProjectAnalytics.mockReset()
  client.seedProjectAnalytics.mockReset()
  client.listProjectConnectors.mockReset()
  client.setProjectConnector.mockReset()
  client.getSecurityScan.mockReset()
  client.runSecurityScan.mockReset()
  client.listBrowserTests.mockReset()
  client.startBrowserTest.mockReset()
  client.listRuns.mockResolvedValue([])
  client.listNotifications.mockResolvedValue({ notifications: [], unread_count: 0 })
  client.listReviews.mockResolvedValue([])
  client.getSecurityScan.mockResolvedValue({
    findings: [],
    passed: true,
    mode: 'offline',
    summary: 'No security findings.',
    notes: ['offline stub — scanners not executed'],
  })
  client.listBrowserTests.mockRejectedValue(new Error('runner unavailable'))
  client.listProjects.mockImplementation(async (options?: { includeArchived?: boolean }) => {
    const rows = [
      { project_id: 'active', name: 'Live app', archived_at: null, run_count: 1 },
      { project_id: 'old', name: 'Old app', archived_at: '2026-01-02T00:00:00Z', run_count: 2 },
    ]
    return options?.includeArchived ? rows : rows.filter((row) => !row.archived_at)
  })
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })))
})

describe('archived projects', () => {
  it('shows Restore when archived rows are included, and Undo after archive', async () => {
    const user = userEvent.setup()
    render(<BuildProjectsPage />, { wrapper })
    expect(await screen.findByText('Live app')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Restore' })).toBeNull()

    await user.click(screen.getByRole('checkbox', { name: 'Show archived' }))
    expect(await screen.findByText('Old app')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Restore' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Archive' }))
    expect(await screen.findByRole('button', { name: 'Undo' })).toBeInTheDocument()
  })
})

describe('stub controls', () => {
  it('does not offer a seed stub and shows an empty analytics state', async () => {
    client.getProjectAnalytics.mockResolvedValue({
      project_id: 'proj_1',
      page_views: 0,
      html_views: 0,
      source: 'sidecar',
      by_path: {},
    })
    render(<AnalyticsPanel projectId="proj_1" />)
    expect(await screen.findByText('No page views yet.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /seed stub/i })).toBeNull()
    expect(screen.queryByText(/sidecar/i)).toBeNull()
    expect(client.seedProjectAnalytics).not.toHaveBeenCalled()
  })

  it('labels an unconfigured connector Off and does not enable it', async () => {
    const user = userEvent.setup()
    client.listProjectConnectors.mockResolvedValue({
      connectors: [{ kind: 'stripe', label: 'Stripe', enabled: true, status: 'stub' }],
    })
    render(<ConnectorsPanel projectId="proj_1" />)
    expect(await screen.findByText('Off')).toBeInTheDocument()
    expect(screen.queryByText('Stub')).toBeNull()
    expect(screen.getByRole('link', { name: 'Add keys' })).toHaveAttribute('href', '/customize/connectors/all')
    await user.click(screen.getByRole('link', { name: 'Add keys' }))
    expect(client.setProjectConnector).not.toHaveBeenCalled()
  })

  it('disables offline security scan and browser test actions', async () => {
    render(<SecurityPanel projectId="proj_1" />, { wrapper })
    render(<BrowserTestsPanel projectId="proj_1" previewUrl={null} />, { wrapper })
    const scan = await screen.findByRole('button', { name: 'Scan now' })
    const test = screen.getByRole('button', { name: 'Run test' })
    expect(scan).toBeDisabled()
    expect(test).toBeDisabled()
    expect(screen.queryByText('Passed')).toBeNull()
    expect(screen.queryByText('No findings yet.')).toBeNull()
    expect(await screen.findByRole('alert')).toHaveTextContent(/runner unavailable/i)
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
    expect(screen.queryByText('No test runs yet.')).toBeNull()
    expect(client.runSecurityScan).not.toHaveBeenCalled()
    expect(client.startBrowserTest).not.toHaveBeenCalled()
  })
})

describe('compare and chat link helpers', () => {
  it('diffs changed lines instead of prefixing every line', () => {
    const diff = unifiedLineDiff('app.txt', 'same\nold', 'same\nnew')
    expect(diff).toContain(' same')
    expect(diff).toContain('-old')
    expect(diff).toContain('+new')
    expect(diff).not.toContain('-same')
    expect(diff).not.toContain('+same')
  })

  it('treats a fake GitHub provider as disconnected', () => {
    expect(githubSyncConnected({ mode: 'live', provider: 'fake' })).toBe(false)
    expect(githubSyncConnected({ mode: 'fake', provider: 'github' })).toBe(false)
    expect(githubSyncConnected({ mode: null, provider: null })).toBe(false)
    expect(githubSyncConnected({ mode: 'github', provider: 'github' })).toBe(true)
  })

  it('links to chat only when the run payload already has a conversation id', () => {
    expect(runConversationId({ run_id: 'run_1', prompt: 'Build a page' })).toBeNull()
    expect(runConversationId({ conversation_id: 'conv_1' })).toBe('conv_1')
    expect(runConversationId({ conversationId: ' conv_2 ' })).toBe('conv_2')
  })
})
