import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { SendButton, sendButtonState } from '../composer/SendButton'

/** The composer's primary action: one morphing control, four states. */
describe('SendButton', () => {
  it('state machine: disabled / ready / running / queued', () => {
    expect(sendButtonState(false, false, 0)).toBe('disabled')
    expect(sendButtonState(false, true, 0)).toBe('ready')
    expect(sendButtonState(true, true, 0)).toBe('running')
    expect(sendButtonState(true, true, 2)).toBe('queued')
    // queued only exists while running
    expect(sendButtonState(false, true, 3)).toBe('ready')
  })

  it('disabled state: submits nothing, no accent, unmistakably off', () => {
    render(<SendButton running={false} canSend={false} onStop={() => {}} />)
    const btn = screen.getByRole('button', { name: 'Send message' })
    expect(btn).toBeDisabled()
    expect(btn.className).toContain('surface')
    expect(btn.className).not.toContain('bg-[var(--accent)]')
  })

  it('ready state: accent token colors, submit type', () => {
    render(<SendButton running={false} canSend={true} onStop={() => {}} />)
    const btn = screen.getByRole('button', { name: 'Send message' })
    expect(btn).not.toBeDisabled()
    expect(btn).toHaveAttribute('type', 'submit')
    expect(btn.className).toContain('bg-[var(--accent)]')
  })

  it('running state: stop glyph (■), pulse ring, button type, calls onStop', () => {
    const onStop = vi.fn()
    render(<SendButton running={true} canSend={true} onStop={onStop} />)
    const btn = screen.getByRole('button', { name: 'Stop response' })
    expect(btn).toHaveAttribute('type', 'button')
    fireEvent.click(btn)
    expect(onStop).toHaveBeenCalledTimes(1)
    expect(btn.querySelector('.pulse-ring')).toBeTruthy()
  })

  it('queued state: count badge with the queue length', () => {
    render(<SendButton running={true} canSend={true} queuedCount={3} onStop={() => {}} />)
    expect(screen.getByText('3')).toBeInTheDocument()
  })

  it('no badge in the plain running state', () => {
    render(<SendButton running={true} canSend={true} queuedCount={0} onStop={() => {}} />)
    expect(screen.queryByLabelText(/queued/)).toBeNull()
  })
})
