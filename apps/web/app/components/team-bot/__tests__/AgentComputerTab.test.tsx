import { describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AgentComputerTab } from '../AgentComputerTab'
import type { TeachSession } from '../useTeachSession'
import { getBotBox, getBotComputerDisk, resetBotComputer, sleepBotComputer } from '../../../lib/bot'

vi.mock('../BotScreen', () => ({ BotScreen: () => <div>screen</div> }))

vi.mock('../../../lib/bot', () => ({
  getBotBox: vi.fn(),
  wakeBotComputer: vi.fn(),
  setBotTakeover: vi.fn(),
  setBotBoxTakeover: vi.fn(),
  settleBotComputer: vi.fn(async () => ({ ok: true, minutes: 0 })),
  sleepBotComputer: vi.fn(async () => ({ alive: false, sandboxId: 'sbx', paused: true })),
  recoverBotComputer: vi.fn(async () => ({ alive: true, sandboxId: 'sbx' })),
  resetBotComputer: vi.fn(async () => ({ alive: true, sandboxId: 'sbx' })),
  getBotComputerDisk: vi.fn(async () => ({ asleep: true, warn: false, rootFreeBytes: null, workspaceFreeBytes: null })),
  BotApiError: class BotApiError extends Error { status = 500 },
}))

const session = {
  phase: 'idle',
  goal: null,
  taskId: null,
  runId: null,
  computer: null,
  frames: 0,
  steps: 0,
  error: '',
  skillId: null,
  skillName: null,
  start: async () => {},
  takeOver: async () => {},
  stop: async () => {},
  cancel: async () => {},
  reset: () => {},
  reportInput: () => {},
} as TeachSession

describe('AgentComputerTab unavailable desktop', () => {
  it('explains that a desktop is unavailable instead of offering wake', () => {
    render(
      <AgentComputerTab
        session={session}
        autoProbe={false}
        unavailableMessage="Computer provider is not configured on this deployment."
      />,
    )
    expect(screen.getByText(/desktop is unavailable/i)).toBeInTheDocument()
    expect(screen.getByText(/not configured/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /wake the computer/i })).not.toBeInTheDocument()
  })

  it('sleeps a live desktop, confirms reset, and shows a low-disk warning', async () => {
    const user = userEvent.setup()
    vi.mocked(getBotBox).mockResolvedValue({
      alive: true,
      paused: false,
      sandboxId: 'sbx',
      viewUrl: 'https://example.test/view',
      interactiveUrl: null,
      resumed: true,
      ageMinutes: 1,
      taskType: 'default',
      workspaceDir: '/workspace',
    })
    vi.mocked(getBotComputerDisk).mockResolvedValue({
      asleep: false,
      warn: true,
      rootFreeBytes: 500_000_000,
      workspaceFreeBytes: 400_000_000,
    })
    vi.mocked(sleepBotComputer).mockResolvedValue({ alive: false, sandboxId: 'sbx', paused: true })
    vi.mocked(resetBotComputer).mockResolvedValue({
      alive: true,
      paused: false,
      sandboxId: 'sbx-clean',
      viewUrl: 'https://example.test/view',
      interactiveUrl: null,
      resumed: false,
      ageMinutes: 0,
      taskType: 'default',
      workspaceDir: '/workspace',
    })
    const openFiles = vi.fn()
    render(<AgentComputerTab session={session} onOpenFiles={openFiles} />)

    expect(await screen.findByRole('button', { name: 'Sleep' })).toBeInTheDocument()
    expect(await screen.findByRole('status')).toHaveTextContent(/low on disk space/i)
    await user.click(screen.getByRole('button', { name: 'Free up space' }))
    expect(openFiles).toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'Sleep' }))
    expect(sleepBotComputer).toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'Reset computer' }))
    expect(resetBotComputer).not.toHaveBeenCalled()
    const confirm = await screen.findByRole('dialog', { name: 'Reset the computer' })
    await user.click(within(confirm).getByRole('button', { name: 'Reset computer' }))
    expect(resetBotComputer).toHaveBeenCalled()
  })

  it('previews beside chat and offers takeover only when the bot needs help', async () => {
    vi.mocked(getBotBox).mockResolvedValue({
      alive: true,
      paused: false,
      sandboxId: 'sbx',
      viewUrl: 'https://example.test/view',
      interactiveUrl: 'https://example.test/interactive',
      resumed: true,
      ageMinutes: 1,
      taskType: 'default',
      workspaceDir: '/workspace',
    })
    const { rerender } = render(<AgentComputerTab session={session} level="preview" />)
    expect(await screen.findByText('screen')).toBeInTheDocument()
    expect(screen.getByTestId('computer-level')).toHaveAttribute('data-level', 'preview')
    expect(screen.queryByRole('button', { name: /take control/i })).not.toBeInTheDocument()

    rerender(<AgentComputerTab session={session} level="takeover" />)
    expect(screen.getByTestId('computer-level')).toHaveAttribute('data-level', 'takeover')
    expect(screen.getByRole('button', { name: /take control/i })).toBeInTheDocument()

    rerender(<AgentComputerTab session={session} level="mark" autoProbe={false} />)
    expect(screen.getByTestId('computer-level')).toHaveAttribute('data-level', 'mark')
    expect(screen.queryByText('screen')).not.toBeInTheDocument()
  })
})
