import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { BotProfilePanel } from '../BotChrome'
import type { NamedBot } from '../../../lib/namedBots'

const listBotSkills = vi.fn()
const listBotRoutines = vi.fn()

vi.mock('../../../lib/bot', () => ({
  listBotSkills: (...args: unknown[]) => listBotSkills(...args),
  listBotRoutines: (...args: unknown[]) => listBotRoutines(...args),
  getBotMemory: async () => ({ memory: '' }),
  deleteBotSkill: async () => ({ ok: true }),
}))

vi.mock('../../team-bot/useTeachSession', () => ({
  useTeachSession: () => ({
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
  }),
}))

vi.mock('../../team-bot/AgentComputerTab', () => ({
  AgentComputerTab: () => null,
}))

vi.mock('../../team-bot/BotFilesPanel', () => ({
  BotFilesPanel: () => null,
}))

const bot: NamedBot = {
  id: 'bot-1',
  name: 'Loop',
  label: '',
  avatarColor: '#c96442',
  persona: '',
  defaultTools: ['web_search'],
  cloudComputer: true,
  isPrimary: true,
  createdAt: '2026-10-24T12:00:00.000Z',
  conversationId: null,
  preview: '',
  updatedAt: null,
  working: false,
}

describe('BotProfilePanel skill list', () => {
  it('shows an error with retry when the skill list fails', async () => {
    window.matchMedia = (query: string) => ({
      matches: query.includes('1024'),
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })
    listBotSkills.mockRejectedValue(new Error('skills down'))
    listBotRoutines.mockResolvedValue({ routines: [] })
    render(<BotProfilePanel bot={bot} onLabel={() => {}} />)
    fireEvent.click(screen.getByRole('tab', { name: 'Library' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/skills down/i)
    expect(screen.queryByText(/no skills yet/i)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
  })
})
