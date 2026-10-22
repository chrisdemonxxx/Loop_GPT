import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { TeachSession } from '../useTeachSession'

vi.mock('../../../lib/bot', () => ({
  getBotBox: vi.fn(async () => ({
    alive: false,
    sandboxId: '',
    viewUrl: null,
    interactiveUrl: null,
    resumed: false,
    ageMinutes: 0,
    taskType: 'default',
    workspaceDir: '',
  })),
  wakeBotComputer: vi.fn(),
  BotApiError: class BotApiError extends Error { status = 0; code = '' },
}))

import { AgentComputerTab } from '../AgentComputerTab'

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

describe('AgentComputerTab stage', () => {
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
  })
})
