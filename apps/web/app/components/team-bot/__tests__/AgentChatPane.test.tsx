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

  it('drops a file into the composer and sends it with the message', () => {
    const onSend = vi.fn(async () => {})
    render(
      <AgentChatPane
        tasks={[]}
        sending={false}
        threadsReady
        onSend={onSend}
        onWatch={() => {}}
        onTrace={() => {}}
        onCancel={() => {}}
      />,
    )
    const drop = screen.getByLabelText('Message')
    const file = new File(['hello'], 'notes.md', { type: 'text/markdown' })
    fireEvent.drop(drop, { dataTransfer: { files: [file] } })
    expect(screen.getByText('notes.md')).toBeInTheDocument()
    fireEvent.change(drop, { target: { value: 'Read this' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(onSend).toHaveBeenCalledWith('Read this', [expect.objectContaining({ name: 'notes.md' })])
  })

  it('resets the thread through a control that is not a delete of the bot', () => {
    const onReset = vi.fn()
    render(
      <AgentChatPane
        tasks={[task({ result: '**Ready**' })]}
        sending={false}
        onSend={async () => {}}
        onWatch={() => {}}
        onTrace={() => {}}
        onCancel={() => {}}
        onReset={onReset}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /reset conversation/i }))
    expect(onReset).toHaveBeenCalled()
    expect(screen.getByText('Ready').tagName).toBe('STRONG')
  })

  it('offers download for a docx artifact and renders other replies as markdown', () => {
    render(
      <AgentChatPane
        tasks={[task({
          kind: 'ops',
          status: 'succeeded',
          result: 'See the brief.',
          artifacts: [{ id: 'a1', kind: 'docx', name: 'brief.docx' }],
        })]}
        sending={false}
        onSend={async () => {}}
        onWatch={() => {}}
        onTrace={() => {}}
        onCancel={() => {}}
      />,
    )
    expect(screen.getByRole('link', { name: /download brief\.docx/i })).toBeInTheDocument()
    expect(screen.queryByRole('img', { name: /brief\.docx/i })).not.toBeInTheDocument()
  })

  it('asks before a computer action and hides the card in accept-all', () => {
    const onApprove = vi.fn()
    const { rerender } = render(
      <AgentChatPane
        tasks={[]}
        sending={false}
        approvalMode="ask"
        pendingApproval={{ id: 'ap1', name: 'computer_click', category: 'computer', args: { x: 1 } }}
        onSend={async () => {}}
        onWatch={() => {}}
        onTrace={() => {}}
        onCancel={() => {}}
        onApprove={onApprove}
        onApprovalMode={() => {}}
      />,
    )
    expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
    expect(onApprove).toHaveBeenCalledWith('ap1', true)
    rerender(
      <AgentChatPane
        tasks={[]}
        sending={false}
        approvalMode="accept"
        pendingApproval={{ id: 'ap1', name: 'computer_click', category: 'computer', args: { x: 1 } }}
        onSend={async () => {}}
        onWatch={() => {}}
        onTrace={() => {}}
        onCancel={() => {}}
        onApprove={onApprove}
        onApprovalMode={() => {}}
      />,
    )
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument()
  })
})
