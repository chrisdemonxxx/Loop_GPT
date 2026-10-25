import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { TeachSession } from '../useTeachSession'

const getBotBox = vi.fn()
const setBotTakeover = vi.fn()
const setBotBoxTakeover = vi.fn()
const settleBotComputer = vi.fn(() => Promise.resolve({ ok: true as const, minutes: 0 }))

vi.mock('../../../lib/bot', () => ({
  getBotBox: (...args: unknown[]) => getBotBox(...args),
  wakeBotComputer: vi.fn(),
  setBotTakeover: (...args: unknown[]) => setBotTakeover(...args),
  setBotBoxTakeover: (...args: unknown[]) => setBotBoxTakeover(...args),
  settleBotComputer: (...args: unknown[]) => settleBotComputer(...args),
  BotApiError: class BotApiError extends Error {
    status: number
    code: string
    constructor(status = 0, code = '', message = '') {
      super(message)
      this.status = status
      this.code = code
    }
  },
}))

vi.mock('../BotScreen', () => ({
  BotScreen: ({ url }: { url: string }) => <div data-testid="bot-screen">{url}</div>,
}))

import { AgentComputerTab } from '../AgentComputerTab'
import { BotApiError } from '../../../lib/bot'

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
  start: vi.fn(),
  takeOver: vi.fn(),
  stop: vi.fn(),
  cancel: vi.fn(),
  reset: vi.fn(),
  reportInput: vi.fn(),
} as unknown as TeachSession

const asleepBox = {
  alive: false,
  sandboxId: '',
  viewUrl: null,
  interactiveUrl: null,
  resumed: false,
  ageMinutes: 0,
  taskType: 'default' as const,
  workspaceDir: '',
}

describe('AgentComputerTab stage', () => {
  beforeEach(() => {
    getBotBox.mockReset()
    setBotTakeover.mockReset()
    setBotBoxTakeover.mockReset()
    settleBotComputer.mockClear()
    getBotBox.mockResolvedValue(asleepBox)
    setBotTakeover.mockResolvedValue({ takeoverRequested: true, interactiveUrl: null })
    setBotBoxTakeover.mockResolvedValue({ takeoverRequested: true, interactiveUrl: null })
  })

  it('uses one 16:9 frame, edge to edge, with no taller black stage around it', async () => {
    const { container } = render(<AgentComputerTab session={session} botName="Helm" onExpand={() => {}} />)
    expect(await screen.findByText("Helm's screen")).toBeInTheDocument()
    const frames = container.querySelectorAll('.aspect-video')
    expect(frames).toHaveLength(1)
    expect(frames[0].className).toContain('w-full')
    expect(frames[0].className).toContain('bg-black')
    for (const el of container.querySelectorAll('.bg-black')) {
      expect(el.className).not.toContain('flex-1')
    }
    expect(container.innerHTML).not.toContain('top-1/2')
    expect(await screen.findByText('This desktop is shared across your bots.')).toBeInTheDocument()
  })

  it('does not show a rollout placeholder when the persistent box is missing', async () => {
    getBotBox.mockRejectedValue(new BotApiError(404, 'not_found', 'missing'))
    render(<AgentComputerTab session={session} botName="Helm" />)
    expect(await screen.findByText('The computer could not be reached. Retry in a minute.')).toBeInTheDocument()
    expect(screen.queryByText(/still rolling out/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/deployment/i)).not.toBeInTheDocument()
  })

  it('says the desktop is starting when the watched run has no stream', async () => {
    render(
      <AgentComputerTab
        session={session}
        botName="Helm"
        runView={{ taskId: 'task-1', runId: 'run-1', viewUrl: null, interactiveUrl: null, starting: true }}
      />,
    )
    expect(await screen.findByText('The desktop is starting.')).toBeInTheDocument()
    expect(screen.queryByText(/still rolling out/i)).not.toBeInTheDocument()
  })

  it('posts takeover and uses the returned interactive url', async () => {
    setBotTakeover.mockResolvedValue({ takeoverRequested: true, interactiveUrl: '/novnc/drive' })
    render(
      <AgentComputerTab
        session={session}
        botName="Helm"
        runView={{ taskId: 'task-1', runId: 'run-9', viewUrl: '/novnc/view', interactiveUrl: null, starting: false }}
      />,
    )
    expect(await screen.findByTestId('bot-screen')).toHaveTextContent('/novnc/view')
    fireEvent.click(await screen.findByRole('button', { name: 'Take control' }))
    await waitFor(() => expect(setBotTakeover).toHaveBeenCalledWith('run-9', true))
    expect(screen.getByTestId('bot-screen')).toHaveTextContent('/novnc/drive')
  })

  it('shows Wake when a stored sandbox has no live stream', async () => {
    getBotBox.mockResolvedValue({
      ...asleepBox,
      alive: false,
      paused: true,
      sandboxId: 'sbx-paused',
    })
    render(<AgentComputerTab session={session} botName="Helm" />)
    expect(await screen.findByRole('button', { name: /wake the computer/i })).toBeInTheDocument()
    expect(screen.getByText('The computer is paused.')).toBeInTheDocument()
    expect(screen.queryByTestId('bot-screen')).not.toBeInTheDocument()
    expect(screen.queryByText(/waking up/i)).not.toBeInTheDocument()
  })
})
