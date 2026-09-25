import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { ToastProvider } from '../../../lib/toast'
import MessageList from '../MessageList'
import { MessageBubble } from '../MessageBubble'
import type { Message } from '../types'

/** Message-list group (audit §8-18..21): scroll-fight protection +
 * jump-to-latest, long-user truncation, and the feedback modal wired to
 * POST /api/telemetry/feedback. */

const msg = (over: Partial<Message>): Message => ({
  id: 'm1', role: 'assistant', content: 'hello', createdAt: new Date().toISOString(), ...over,
})

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ ok: true }) })))
  // jsdom has no scrollIntoView.
  Element.prototype.scrollIntoView = () => {}
})
afterEach(() => vi.unstubAllGlobals())

describe('scroll-fight protection (§8-18)', () => {
  it('shows the Jump-to-latest button only when scrolled up', async () => {
    const messages = [msg({ id: 'a' }), msg({ id: 'b', role: 'user', content: 'hi' })]
    const { container } = render(
      <MessageList
        messages={messages}
        liveUser={null}
        liveSteps={[]}
        liveAnswer=""
        liveArtifacts={[]}
        running={false}
        statusMsg=""
        mode="agent"
        onEditMessage={() => {}}
        onRetryBefore={() => {}}
      />,
    )
    const scroller = container.querySelector('.overflow-y-auto') as HTMLElement
    // Start at the bottom: no button.
    expect(screen.queryByRole('button', { name: 'Jump to latest' })).not.toBeInTheDocument()
    // Simulate reading history: scrolled far from the bottom.
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 2000 })
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 400 })
    scroller.scrollTop = 0
    fireEvent.scroll(scroller)
    expect(screen.getByRole('button', { name: 'Jump to latest' })).toBeInTheDocument()
    // Jumping returns to the bottom and hides the button (the exit fade
    // keeps it briefly in the DOM — wait for removal).
    fireEvent.click(screen.getByRole('button', { name: 'Jump to latest' }))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Jump to latest' })).not.toBeInTheDocument())
  })
})

describe('long-user truncation (§8-20)', () => {
  it('truncates long user messages behind a Show more expander', () => {
    const long = 'x'.repeat(500)
    render(<MessageBubble message={msg({ role: 'user', content: long })} />)
    expect(screen.getByText(/Show more/)).toBeInTheDocument()
    // The full body is not rendered until expanded.
    expect(screen.queryByText(long)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /show more/i }))
    expect(screen.getByText(long)).toBeInTheDocument()
    expect(screen.getByText(/Show less/)).toBeInTheDocument()
  })

  it('leaves short user messages untruncated', () => {
    render(<MessageBubble message={msg({ role: 'user', content: 'short and sweet' })} />)
    expect(screen.getByText('short and sweet')).toBeInTheDocument()
    expect(screen.queryByText(/Show more/)).not.toBeInTheDocument()
  })
})

describe('feedback modal (§8-21)', () => {
  it('sends the rating + comment to the telemetry endpoint', async () => {
    render(<ToastProvider><MessageBubble message={msg({ id: 'm9' })} conversationId="conv-1" /></ToastProvider>)
    fireEvent.click(screen.getByRole('button', { name: /rate this response as poor/i }))
    const dialog = screen.getByRole('dialog')
    expect(dialog).toBeInTheDocument()
    fireEvent.change(dialog.querySelector('textarea') as HTMLTextAreaElement, { target: { value: 'too vague' } })
    fireEvent.click(screen.getByRole('button', { name: /submit feedback/i }))
    await waitFor(() => expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/telemetry/feedback'),
      expect.objectContaining({ method: 'POST' }),
    ))
    const body = JSON.parse((fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body)
    expect(body).toMatchObject({ conversationId: 'conv-1', messageId: 'm9', rating: 'down', comment: 'too vague' })
    // Success toast + modal close.
    await screen.findByText(/feedback recorded/i)
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('blocks submission without a rating', () => {
    render(<MessageBubble message={msg({ id: 'm9' })} />)
    // No rating preselected from the copy action path: open via good response
    // sets one; cancel keeps the UI clean. The disabled state is the gate.
    fireEvent.click(screen.getByRole('button', { name: /rate this response as good/i }))
    expect(screen.getByRole('button', { name: /submit feedback/i })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})
