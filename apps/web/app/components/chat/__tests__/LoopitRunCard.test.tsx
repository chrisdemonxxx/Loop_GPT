import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { LoopitRunCard } from '../LoopitRunCard'

vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: { href: string; children: ReactNode }) => <a href={href} {...props}>{children}</a>,
}))

describe('LoopitRunCard', () => {
  it('links the run to its Build page', () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={client}>
        <LoopitRunCard runId="run_abc123" />
      </QueryClientProvider>,
    )
    const link = screen.getByRole('link', { name: 'Open build' })
    expect(link.getAttribute('href')).toBe('/build/?run=run_abc123')
    // The internal run id is never rendered — the card goes by its title.
    expect(screen.queryByText('run_abc123')).toBeNull()
  })
})
