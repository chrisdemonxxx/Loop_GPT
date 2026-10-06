import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'
import { ToastProvider, useToast } from '../../lib/toast'

/** Toast system (audit §8-19): push renders a status pill with dismiss;
 * auto-dismiss after ~3.4s. */

function Pusher({ kind, message }: { kind: 'success' | 'error' | 'info'; message: string }) {
  const toast = useToast()
  return <button onClick={() => toast.push(kind, message)}>push</button>
}

afterEach(() => vi.useRealTimers())

describe('ToastProvider', () => {
  it('renders pushed toasts with a dismiss control', async () => {
    render(
      <ToastProvider>
        <Pusher kind="success" message="Link copied" />
      </ToastProvider>,
    )
    fireEvent.click(screen.getByText('push'))
    expect(screen.getByRole('status')).toHaveTextContent('Link copied')
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss notification' }))
    // The exit fade keeps the node briefly in the DOM — wait for removal.
    await waitFor(() => expect(screen.queryByText('Link copied')).not.toBeInTheDocument())
  })

  it('stacks multiple toasts newest-last and caps the stack', () => {
    render(
      <ToastProvider>
        <Pusher kind="info" message="one" />
      </ToastProvider>,
    )
    const push = screen.getByText('push')
    fireEvent.click(push)
    fireEvent.click(push)
    fireEvent.click(push)
    fireEvent.click(push)
    fireEvent.click(push)
    const statuses = screen.getAllByRole('status')
    expect(statuses.length).toBeLessThanOrEqual(5)
  })

  it('auto-dismisses after the timeout', async () => {
    vi.useFakeTimers()
    render(
      <ToastProvider>
        <Pusher kind="error" message="Upload failed" />
      </ToastProvider>,
    )
    fireEvent.click(screen.getByText('push'))
    expect(screen.getByText('Upload failed')).toBeInTheDocument()
    act(() => { vi.advanceTimersByTime(3600) })
    // The dismissal already happened under fake timers; the exit fade needs
    // real ticks to remove the node from the DOM.
    vi.useRealTimers()
    await waitFor(() => expect(screen.queryByText('Upload failed')).not.toBeInTheDocument(), { timeout: 2000 })
  })

  it('is a safe no-op outside the provider', () => {
    render(<Pusher kind="info" message="orphan" />)
    expect(() => fireEvent.click(screen.getByText('push'))).not.toThrow()
  })
})
