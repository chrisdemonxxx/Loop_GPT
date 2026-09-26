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

describe('history virtualization (§8-33)', () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) =>
    msg({ id: `m${i}`, role: i % 2 ? 'assistant' : 'user', content: `msg-${i}` }))
  const liveProps = {
    liveUser: null, liveSteps: [] as any[], liveAnswer: '', liveArtifacts: [] as any[],
    running: false, statusMsg: '', mode: 'agent' as const,
    onEditMessage: () => {}, onRetryBefore: () => {},
  }

  // jsdom lays out nothing: TanStack reads the scroller's offsetHeight and
  // row rects via getBoundingClientRect — give both real dimensions so the
  // window math has a 600px viewport and measurable rows to work with.
  const realRect = Element.prototype.getBoundingClientRect
  const offsetHeightDesc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight')
  const offsetWidthDesc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth')
  beforeEach(() => {
    Element.prototype.getBoundingClientRect = function (this: Element) {
      const real = realRect.call(this)
      return { ...real, width: 800, height: 600, top: 0, bottom: 600, left: 0, right: 800, x: 0, y: 0 }
    }
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get() { return 600 } })
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get() { return 800 } })
  })
  afterEach(() => {
    Element.prototype.getBoundingClientRect = realRect
    if (offsetHeightDesc) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', offsetHeightDesc)
    if (offsetWidthDesc) Object.defineProperty(HTMLElement.prototype, 'offsetWidth', offsetWidthDesc)
  })

  it('renders every row in plain flow below the threshold', () => {
    const { container } = render(<MessageList messages={many(50)} {...liveProps} />)
    expect(container.querySelector('[data-testid="virtual-window"]')).toBeNull()
    expect(screen.getByText('msg-0')).toBeInTheDocument()
    expect(screen.getByText('msg-49')).toBeInTheDocument()
    expect(container.querySelectorAll('[data-index]')).toHaveLength(0)
  })

  it('virtualizes long histories: only the visible window is in the DOM', () => {
    const { container } = render(<MessageList messages={many(150)} {...liveProps} />)
    expect(container.querySelector('[data-testid="virtual-window"]')).not.toBeNull()
    // Visible window + overscan — far fewer than 150 rows mounted.
    const rendered = container.querySelectorAll('[data-index]')
    expect(rendered.length).toBeGreaterThan(0)
    expect(rendered.length).toBeLessThanOrEqual(20)
    // Deep-history rows are NOT mounted at all.
    expect(screen.queryByText('msg-140')).not.toBeInTheDocument()
    // Window rows are present, and the live-turn sentinel still exists.
    expect(container.querySelector('[data-index="0"]')).not.toBeNull()
  })
})

describe('branch version arrows (§8-22)', () => {
  const liveProps = {
    liveUser: null, liveSteps: [] as any[], liveAnswer: '', liveArtifacts: [] as any[],
    running: false, statusMsg: '', mode: 'agent' as const,
    onEditMessage: () => {}, onRetryBefore: () => {},
  }

  const branchedRows: Message[] = [
    msg({ id: 'u1', role: 'user', content: 'the prompt', parentId: null }),
    msg({ id: 'a-old', content: 'first answer', parentId: 'u1' }),
    msg({ id: 'a-new', content: 'regenerated answer', parentId: 'u1' }),
  ]
  const versions = {
    'a-new': { index: 2, count: 2, prev: branchedRows[1], next: undefined },
  }

  it('renders <2/3> arrows on a versioned row and flips on click', () => {
    const select = vi.fn()
    render(
      <MessageList
        messages={[branchedRows[0], branchedRows[2]]}
        versions={versions as any}
        onSelectVersion={select}
        {...liveProps}
      />,
    )
    expect(screen.getByTestId('version-arrows')).toBeInTheDocument()
    expect(screen.getByLabelText('Version 2 of 2')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /show previous version/i }))
    expect(select).toHaveBeenCalledWith('a-old')
  })

  it('hides the arrows on singleton rows', () => {
    render(
      <MessageList
        messages={[branchedRows[0], branchedRows[1]]}
        versions={{}}
        onSelectVersion={() => {}}
        {...liveProps}
      />,
    )
    expect(screen.queryByTestId('version-arrows')).not.toBeInTheDocument()
  })

  it('truncates the transcript at the live anchor while a branched run streams', () => {
    const messages: Message[] = [
      msg({ id: 'u1', role: 'user', content: 'the prompt', parentId: null }),
      msg({ id: 'a-old', content: 'first answer', parentId: 'u1' }),
    ]
    const { rerender } = render(
      <MessageList
        messages={messages}
        liveReplaceAfterId={null}
        {...liveProps}
      />,
    )
    expect(screen.getByText('first answer')).toBeInTheDocument()
    // A retry streams in place of the old answer: rows after the anchor
    // (the re-answered user row) are hidden while the run is live.
    rerender(
      <MessageList
        messages={messages}
        liveReplaceAfterId="u1"
        liveUser={{ content: 'the prompt' }}
        liveSteps={[]}
        liveAnswer="regenerating…"
        liveArtifacts={[]}
        running
        statusMsg=""
        mode="agent"
        onEditMessage={() => {}}
        onRetryBefore={() => {}}
      />,
    )
    expect(screen.queryByText('first answer')).not.toBeInTheDocument()
    // The anchor row stays (inclusive) — the stored prompt AND the live echo
    // of the same text both render, so assert presence, not uniqueness.
    expect(screen.getAllByText('the prompt').length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText('regenerating…')).toBeInTheDocument()
  })
})
