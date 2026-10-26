import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { LibraryBoard } from '../LibraryBoard'

describe('LibraryBoard', () => {
  it('keeps skills as a subtab and shares a page with a revocable link', () => {
    const onShare = vi.fn()
    const onRevoke = vi.fn()
    render(
      <LibraryBoard
        skills={<p>Skill list</p>}
        items={[
          { id: 'p1', kind: 'page', name: 'Launch', path: '/workspace/sites/launch/index.html', shareUrl: null },
          { id: 'f1', kind: 'file', name: 'Notes', path: '/workspace/exports/notes.md', shareUrl: null },
          { id: 'a1', kind: 'app', name: 'Board', path: '/workspace/sites/board/index.html', shareUrl: 'https://loop.test/share/tok' },
        ]}
        onShare={onShare}
        onRevoke={onRevoke}
      />,
    )
    expect(screen.getByRole('tab', { name: 'Skills' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByText('Skill list')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('tab', { name: 'Pages' }))
    fireEvent.click(screen.getByRole('button', { name: 'Share Launch' }))
    expect(onShare).toHaveBeenCalledWith('p1')
    fireEvent.click(screen.getByRole('tab', { name: 'Apps' }))
    fireEvent.click(screen.getByRole('button', { name: 'Revoke Board link' }))
    expect(onRevoke).toHaveBeenCalledWith('a1')
  })
})
