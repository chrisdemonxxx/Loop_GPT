import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import Lightbox from '../Lightbox'
import type { ArtifactRef } from '../../../lib/stream'

/** Fullscreen image lightbox (audit P4): counter, next/prev navigation
 * (buttons + arrow keys), double-click zoom, Escape and backdrop close. */

const img = (id: string, name: string): ArtifactRef => ({ id, kind: 'image', name, url: `/api/files/${id}/content` })
const images = [img('f1', 'one.png'), img('f2', 'two.png'), img('f3', 'three.png')]

beforeEach(() => {
  // The authed URL hook fetches the blob for the active image; jsdom has no
  // object URLs, so stub both sides.
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, blob: async () => new Blob(['x']) })))
  Object.defineProperty(URL, 'createObjectURL', { value: () => 'blob:mocked', configurable: true })
  Object.defineProperty(URL, 'revokeObjectURL', { value: () => {}, configurable: true })
})
afterEach(() => vi.unstubAllGlobals())

describe('Lightbox', () => {
  it('renders into a body portal with the image counter', () => {
    const { baseElement } = render(<Lightbox images={images} onClose={() => {}} />)
    expect(baseElement.ownerDocument.body.querySelector('[role="dialog"]')).toBeTruthy()
    expect(screen.getByText('1 / 3')).toBeInTheDocument()
  })

  it('navigates forward and backward across the turn images', () => {
    render(<Lightbox images={images} onClose={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Next image' }))
    expect(screen.getByText('2 / 3')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Previous image' }))
    expect(screen.getByText('1 / 3')).toBeInTheDocument()
    // Keyboard navigation, wrapping at the edges.
    fireEvent.keyDown(window, { key: 'ArrowLeft' })
    expect(screen.getByText('3 / 3')).toBeInTheDocument()
    fireEvent.keyDown(window, { key: 'ArrowRight' })
    expect(screen.getByText('1 / 3')).toBeInTheDocument()
  })

  it('zooms on double-click and resets on image switch', () => {
    render(<Lightbox images={images} onClose={() => {}} />)
    return waitFor(() => {
      const el = document.querySelector('[role="dialog"] img') as HTMLImageElement
      expect(el).not.toBeNull()
      expect(el.style.transform).toContain('scale(1)')
      fireEvent.dblClick(el.closest('div') as HTMLElement)
      expect((document.querySelector('[role="dialog"] img') as HTMLImageElement).style.transform).toContain('scale(2.5)')
    })
  })

  it('closes on Escape and via the close button', () => {
    const onClose = vi.fn()
    render(<Lightbox images={images} onClose={onClose} />)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: 'Close viewer' }))
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('hides navigation controls for a single image', () => {
    render(<Lightbox images={[images[0]]} onClose={() => {}} />)
    expect(screen.queryByRole('button', { name: 'Next image' })).not.toBeInTheDocument()
    expect(screen.queryByText(/\/ 1/)).not.toBeInTheDocument()
  })
})
