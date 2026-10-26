import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { MemoryPanel } from '../MemoryPanel'

describe('MemoryPanel', () => {
  it('adds a private memory by default and can mark one team', () => {
    const onAdd = vi.fn()
    const onDelete = vi.fn()
    render(
      <MemoryPanel
        memories={[{ id: 'm1', content: 'Ships on Fridays', visibility: 'private', createdAt: '2026-10-25T00:00:00.000Z' }]}
        onAdd={onAdd}
        onDelete={onDelete}
      />,
    )
    expect(screen.getByText('Ships on Fridays')).toBeInTheDocument()
    expect(screen.getByText('Private')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('New memory'), { target: { value: 'Standup is at nine' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add memory' }))
    expect(onAdd).toHaveBeenCalledWith({ content: 'Standup is at nine', visibility: 'private' })
    fireEvent.click(screen.getByRole('checkbox', { name: 'Team' }))
    fireEvent.click(screen.getByRole('button', { name: 'Add memory' }))
    expect(onAdd).toHaveBeenCalledWith({ content: 'Standup is at nine', visibility: 'team' })
    fireEvent.click(screen.getByRole('button', { name: 'Delete memory Ships on Fridays' }))
    expect(onDelete).toHaveBeenCalledWith('m1')
  })
})
