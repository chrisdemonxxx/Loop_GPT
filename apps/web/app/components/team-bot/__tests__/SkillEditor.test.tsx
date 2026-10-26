import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { SkillEditor } from '../SkillEditor'

describe('SkillEditor', () => {
  it('saves markdown and when-to-use, and run queues that skill', () => {
    const onSave = vi.fn()
    const onRun = vi.fn()
    render(<SkillEditor onSave={onSave} onRun={onRun} />)
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Invoice export' } })
    fireEvent.change(screen.getByLabelText('When to use'), { target: { value: 'Pull the CSV from billing' } })
    fireEvent.change(screen.getByLabelText('Instructions'), { target: { value: '# Steps\n\nOpen billing.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save skill' }))
    expect(onSave).toHaveBeenCalledWith({
      name: 'Invoice export',
      description: 'Pull the CSV from billing',
      instructions: '# Steps\n\nOpen billing.',
    })
    fireEvent.click(screen.getByRole('button', { name: 'Run skill' }))
    expect(onRun).toHaveBeenCalledWith(expect.objectContaining({ name: 'Invoice export' }))
  })
})
