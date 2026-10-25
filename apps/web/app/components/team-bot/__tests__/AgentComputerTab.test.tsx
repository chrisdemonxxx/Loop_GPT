import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { AgentComputerTab } from '../AgentComputerTab'
import type { TeachSession } from '../useTeachSession'

vi.mock('../../../lib/bot', () => ({
  getBotBox: vi.fn(),
  wakeBotComputer: vi.fn(),
  setBotTakeover: vi.fn(),
  setBotBoxTakeover: vi.fn(),
  settleBotComputer: vi.fn(),
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
})
