import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { TeachSession } from '../useTeachSession'

const getBotBox = vi.fn()

vi.mock('../../../lib/bot', () => ({
  getBotBox: (...args: unknown[]) => getBotBox(...args),
  wakeBotComputer: vi.fn(),
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
    getBotBox.mockResolvedValue(asleepBox)
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
})
