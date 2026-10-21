import type { ReactNode } from 'react'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CheckpointView, RunDetail } from '@loop/loopit-client'
import { ToastProvider } from '../../lib/toast'

const client = vi.hoisted(() => ({
  getRun: vi.fn(),
  getMe: vi.fn(),
  getHealth: vi.fn(),
  startRun: vi.fn(),
  streamRunEvents: vi.fn(),
  createPreviewUrl: vi.fn(),
  forkCheckpoint: vi.fn(),
  rollbackCheckpoint: vi.fn(),
  deployProject: vi.fn(),
  sendRunMessage: vi.fn(),
  cancelRun: vi.fn(),
  getFile: vi.fn(),
}))

const nav = vi.hoisted(() => ({
  push: vi.fn(),
  params: {} as Record<string, string>,
}))

vi.mock('@loop/loopit-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@loop/loopit-client')>()),
  getRun: client.getRun,
  getMe: client.getMe,
  getHealth: client.getHealth,
  startRun: client.startRun,
  streamRunEvents: client.streamRunEvents,
  createPreviewUrl: client.createPreviewUrl,
  forkCheckpoint: client.forkCheckpoint,
  rollbackCheckpoint: client.rollbackCheckpoint,
  deployProject: client.deployProject,
  sendRunMessage: client.sendRunMessage,
  cancelRun: client.cancelRun,
  getFile: client.getFile,
}))

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: nav.push }),
  useParams: () => nav.params,
}))

vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: { href: string; children: ReactNode }) => (
    <a href={href} {...props}>{children}</a>
  ),
}))

import RunView from '../[runId]/RunView'

const CHECKPOINT: CheckpointView = {
  checkpoint_id: 'cp_1',
  parent_id: null,
  created_at: '2026-10-20T12:00:00.000Z',
  verified: true,
  live: true,
}

function finishedRun(overrides: Partial<RunDetail> = {}): RunDetail {
  return {
    run_id: 'run_1',
    project_id: 'proj_1',
    prompt: 'Build a landing page',
    title: 'Landing page',
    status: 'error',
    started_at: '2026-10-20T12:00:00.000Z',
    finished_at: '2026-10-20T12:01:00.000Z',
    iterations: 2,
    summary: 'Stopped with an error',
    credits_spent: 0.01,
    files: ['App.js', 'styles.css'],
    checkpoints: [CHECKPOINT],
    ...overrides,
  }
}

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>{children}</ToastProvider>
    </QueryClientProvider>
  )
}

beforeEach(() => {
  for (const fn of Object.values(client)) fn.mockReset()
  nav.push.mockReset()
  client.getMe.mockResolvedValue({
    user_id: 'u', email: null, org_id: 'o', role: 'owner', scopes: ['api', 'runs'],
  })
  client.getHealth.mockResolvedValue({
    status: 'ok', offline: false, exec_enabled: false, projects_root: '/', run_execution_mode: 'local',
  })
  client.streamRunEvents.mockResolvedValue(undefined)
  client.createPreviewUrl.mockResolvedValue({
    url: '/api/loopit/projects/proj_1/site/t/tok/App.js',
    expiresAt: Date.now() + 900_000,
  })
  client.startRun.mockResolvedValue({ run_id: 'run_followup', project_id: 'proj_1', status: 'queued' })
  client.forkCheckpoint.mockResolvedValue({ project_id: 'proj_fork' })
  client.rollbackCheckpoint.mockResolvedValue(undefined)
})

describe('RunView Phase 0 controls (B27)', () => {
  it('Continue starts a follow-up run on the same projectId', async () => {
    const user = userEvent.setup()
    client.getRun.mockResolvedValue(finishedRun({ status: 'error' }))
    render(<RunView runId="run_1" />, { wrapper })

    await screen.findByRole('button', { name: /Continue/i })
    const composer = screen.getByPlaceholderText(/Tell the builder what to change/i)
    await user.type(composer, 'Fix the header')
    await user.click(screen.getByRole('button', { name: /Continue/i }))

    await waitFor(() => {
      expect(client.startRun).toHaveBeenCalledWith('Fix the header', { projectId: 'proj_1' })
    })
    expect(nav.push).toHaveBeenCalledWith('/build/?run=run_followup')
  })

  it('Save a copy forks then navigates to a new run on the forked project', async () => {
    const user = userEvent.setup()
    client.getRun.mockResolvedValue(finishedRun({ status: 'completed' }))
    client.startRun.mockResolvedValue({ run_id: 'run_forked', project_id: 'proj_fork', status: 'queued' })
    render(<RunView runId="run_1" />, { wrapper })

    await screen.findByRole('button', { name: /Save a copy/i })
    await user.click(screen.getByRole('button', { name: /Save a copy/i }))
    const dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: /^Save a copy$/i }))

    await waitFor(() => {
      expect(client.forkCheckpoint).toHaveBeenCalledWith('proj_1', 'cp_1')
    })
    await waitFor(() => {
      expect(client.startRun).toHaveBeenCalledWith(
        expect.any(String),
        { projectId: 'proj_fork' },
      )
    })
    expect(nav.push).toHaveBeenCalledWith('/build/?run=run_forked')
  })

  it('refuses Roll back while the run is live', async () => {
    client.getRun.mockResolvedValue(finishedRun({ status: 'running', finished_at: null }))
    render(<RunView runId="run_1" />, { wrapper })

    const rollback = await screen.findByRole('button', { name: /Roll back here/i })
    expect(rollback).toBeDisabled()
    expect(rollback).toHaveAttribute('title', 'Stop the build before rolling back')
  })

  it('rollback on a finished run bumps the preview iframe epoch', async () => {
    const user = userEvent.setup()
    client.getRun.mockResolvedValue(finishedRun({ status: 'completed' }))
    render(<RunView runId="run_1" />, { wrapper })

    const iframe = await waitFor(() => {
      const el = document.querySelector('iframe')
      if (!el) throw new Error('iframe not ready')
      return el
    })

    await user.click(screen.getByRole('button', { name: /Roll back here/i }))
    const dialog = await screen.findByRole('alertdialog')
    await user.click(within(dialog).getByRole('button', { name: /^Roll back$/i }))

    await waitFor(() => {
      expect(client.rollbackCheckpoint).toHaveBeenCalledWith('proj_1', 'cp_1')
    })
    // Epoch remount: React replaces the iframe node even when the URL string is unchanged.
    await waitFor(() => {
      const after = document.querySelector('iframe')
      expect(after).not.toBeNull()
      expect(after).not.toBe(iframe)
    })
  })

  it('previews a non-html entry file when no index.html exists', async () => {
    client.getRun.mockResolvedValue(finishedRun({
      status: 'completed',
      files: ['App.js', 'styles.css'],
    }))
    render(<RunView runId="run_1" />, { wrapper })

    await waitFor(() => {
      expect(client.createPreviewUrl).toHaveBeenCalledWith('proj_1', 'App.js')
    })
    // Chrome bar shows the selected path (not gated on .html).
    expect(await screen.findByText('App.js')).toBeInTheDocument()
  })

  it('falls back to index.html when the project has no files yet', async () => {
    client.getRun.mockResolvedValue(finishedRun({
      status: 'completed',
      files: [],
    }))
    client.createPreviewUrl.mockResolvedValue({
      url: '/api/loopit/projects/proj_1/site/t/tok/index.html',
      expiresAt: Date.now() + 900_000,
    })
    render(<RunView runId="run_1" />, { wrapper })

    await waitFor(() => {
      expect(client.createPreviewUrl).toHaveBeenCalledWith('proj_1', 'index.html')
    })
  })
})

describe('useCheckpointAction rollback lock (B14)', () => {
  it('throws when rollback is attempted while live', async () => {
    const { renderHook } = await import('@testing-library/react')
    const { useCheckpointAction } = await import('../hooks')

    const { result } = renderHook(
      () => useCheckpointAction('run_1', 'proj_1', { live: true }),
      { wrapper },
    )

    await expect(
      act(async () => result.current.mutateAsync({
        pending: { kind: 'rollback', checkpoint: CHECKPOINT },
        reason: 'test',
      })),
    ).rejects.toThrow(/Stop the build before rolling back/i)
    expect(client.rollbackCheckpoint).not.toHaveBeenCalled()
  })
})
