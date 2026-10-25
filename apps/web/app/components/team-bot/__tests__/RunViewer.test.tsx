import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import RunViewer from '../RunViewer'

const retry = vi.fn()
const setLoadError = vi.fn()
const stream = {
  task: { id: 't1', goal: 'Check deploys', kind: 'ops', schedule: null, runs: [{ id: 'r1', status: 'completed' }] },
  events: [] as Array<{ type: string; message?: string }>,
  live: false,
  loadError: '',
  ended: true,
  retry,
  setLoadError,
}

vi.mock('../useRunStream', () => ({
  useRunStream: () => stream,
}))

beforeEach(() => {
  retry.mockReset()
  setLoadError.mockReset()
  stream.events = []
  stream.live = false
  stream.loadError = ''
  Element.prototype.scrollIntoView = () => {}
  window.matchMedia = (query: string) => ({
    matches: true,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })
})

describe('RunViewer trace status', () => {
  it('shows an empty trace as an error with Retry', () => {
    render(<RunViewer taskId="t1" onClose={() => {}} />)
    expect(screen.queryByText(/attaching/i)).not.toBeInTheDocument()
    expect(screen.getAllByRole('alert')[0]).toHaveTextContent(/trace is empty/i)
    fireEvent.click(screen.getAllByRole('button', { name: 'Retry' })[0])
    expect(retry).toHaveBeenCalled()
  })

  it('clears the error on Dismiss without retrying', () => {
    stream.loadError = 'stream exploded'
    render(<RunViewer taskId="t1" onClose={() => {}} />)
    fireEvent.click(screen.getAllByRole('button', { name: 'Dismiss' })[0])
    expect(setLoadError).toHaveBeenCalledWith('')
    expect(retry).not.toHaveBeenCalled()
  })
})
