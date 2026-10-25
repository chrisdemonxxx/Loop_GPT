import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { AgentChatPane } from '../AgentChatPane'
import type { BotQuota, BotTask } from '../../../lib/bot'

function task(over: Partial<BotTask> = {}): BotTask {
  return {
    id: 'task-1',
    kind: 'scheduled',
    goal: 'Check deploys',
    status: 'queued',
    schedule: '1d',
    model: null,
    priority: 0,
    attempts: 1,
    failures: 0,
    nextAttemptAt: '2099-01-01T00:00:00.000Z',
    cancelRequested: false,
    lastErrorCode: null,
    result: 'All green',
    createdAt: '2026-10-24T12:00:00.000Z',
    updatedAt: '2026-10-24T12:05:00.000Z',
    ...over,
  }
}

const quotaOff: BotQuota = {
  plan: 'free',
  unlimited: false,
  computerAllowed: false,
  computerConfigured: false,
  cap: 0,
  used: 0,
  remaining: 0,
  resetsAt: '2026-10-25T00:00:00.000Z',
}

describe('AgentChatPane routines and computer gate', () => {
  it('shows the latest result and next run for a waiting routine', () => {
    const onCancel = vi.fn()
    render(
      <AgentChatPane
        tasks={[task()]}
        sending={false}
        onSend={async () => {}}
        onWatch={() => {}}
        onTrace={() => {}}
        onCancel={onCancel}
      />,
    )
    expect(screen.getByText('All green')).toBeInTheDocument()
    expect(screen.getByText(/next run/i)).toBeInTheDocument()
    expect(screen.queryByText(/picking it up now/i)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /watch/i })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /cancel schedule/i }))
    expect(onCancel).toHaveBeenCalledWith('task-1')
  })

  it('keeps send available when the computer provider is off', () => {
    const onSend = vi.fn(async () => {})
    render(
      <AgentChatPane
        tasks={[]}
        sending={false}
        quota={quotaOff}
        requiresComputer
        botName="Loop"
        onSend={onSend}
        onWatch={() => {}}
        onTrace={() => {}}
        onCancel={() => {}}
      />,
    )
    expect(screen.getByRole('alert')).toHaveTextContent(/not configured/i)
    const box = screen.getByRole('textbox', { name: /message loop/i })
    expect(box).toBeEnabled()
    fireEvent.change(box, { target: { value: 'Summarize the inbox' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(onSend).toHaveBeenCalledWith('Summarize the inbox')
  })
})
