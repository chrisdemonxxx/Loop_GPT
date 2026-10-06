import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { EmptyState, ThinkingDots } from '../EmptyState'

/** Thinking pulse (audit P5): the pre-activity affordance in the assistant
 * turn — labeled, announced as status, with the animated dots (disabled
 * under reduced-motion by the global CSS kill-switch). */

describe('ThinkingDots', () => {
  it('announces itself as a status region with the Thinking… label', () => {
    render(<ThinkingDots />)
    const status = screen.getByRole('status')
    expect(status).toHaveAttribute('aria-label', 'Thinking')
    expect(screen.getByText('Thinking…')).toBeInTheDocument()
    // Three staggered pulse dots (decorative).
    expect(status.querySelectorAll('span[aria-hidden="true"] span')).toHaveLength(3)
  })
})

describe('EmptyState', () => {
  it('renders starter prompts and dispatches clicks', () => {
    const onStartPrompt = vi.fn()
    render(<EmptyState onStartPrompt={onStartPrompt} />)
    expect(screen.getByText(/how can I help you today\?/i)).toBeInTheDocument()
    const prompt = screen.getByText('Explain quantum computing like I’m 10')
    expect(prompt).toBeInTheDocument()
    prompt.click()
    expect(onStartPrompt).toHaveBeenCalledWith('Explain quantum computing like I’m 10')
  })
})
