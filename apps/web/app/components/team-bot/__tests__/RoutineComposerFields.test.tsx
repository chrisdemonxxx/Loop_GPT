import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { RoutineComposerFields } from '../RoutineComposerFields'

describe('RoutineComposerFields', () => {
  it('emits a preset, an IANA zone, and the next run in that zone', () => {
    const onChange = vi.fn()
    render(<RoutineComposerFields value="1d" timeZone="UTC" onChange={onChange} now={new Date('2026-03-07T12:00:00.000Z')} />)
    fireEvent.change(screen.getByLabelText('Schedule'), { target: { value: 'daily' } })
    fireEvent.change(screen.getByLabelText('Time'), { target: { value: '09:30' } })
    fireEvent.change(screen.getByLabelText('Timezone'), { target: { value: 'America/New_York' } })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
      schedule: 'daily@09:30|America/New_York|away',
    }))
    expect(screen.getByText(/next run/i).textContent).toMatch(/9:30/)
  })
})
