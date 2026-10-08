import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { LoopitRunCard } from '../LoopitRunCard'

vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: { href: string; children: ReactNode }) => <a href={href} {...props}>{children}</a>,
}))

describe('LoopitRunCard', () => {
  it('offers the build preview for the linked run', () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={client}>
        <LoopitRunCard runId="run_abc123" />
      </QueryClientProvider>,
    )
    const link = screen.getByRole('link', { name: 'Open preview' })
    expect(link.getAttribute('href')).toBe('/build/?run=run_abc123')
    expect(screen.getByText('run_abc123')).toBeTruthy()
  })
})
