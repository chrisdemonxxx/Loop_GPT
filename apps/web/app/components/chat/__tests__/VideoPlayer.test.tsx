import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import VideoPlayer from '../VideoPlayer'
import type { ArtifactRef } from '../../../lib/stream'

/** Streaming video player (audit P3): signed URL minting (real byte-range
 * HTTP, not blob download), buffering indicator, and the expired-link retry. */

const video: ArtifactRef = { id: 'v1', kind: 'video', name: 'clip.mp4', url: '/api/files/f-video/content', mimeType: 'video/mp4' }

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ url: '/api/files/f-video/content?p=PAYLOAD&s=SIG', expiresIn: 300 }) })))
})
afterEach(() => vi.unstubAllGlobals())

function renderPlayer() {
  const utils = render(<VideoPlayer a={video} />)
  const videoEl = () => utils.container.querySelector('video') as HTMLVideoElement
  return { ...utils, videoEl }
}

describe('VideoPlayer', () => {
  it('mints a signed link and streams from it (no blob download)', async () => {
    const { videoEl } = renderPlayer()
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/files/f-video/signed-link', expect.objectContaining({ method: 'POST' })))
    await waitFor(() => expect(videoEl()).not.toBeNull())
    expect(videoEl().getAttribute('src')).toContain('/api/files/f-video/content?p=PAYLOAD&s=SIG')
    expect(videoEl().getAttribute('preload')).toBe('metadata')
  })

  it('shows the minting placeholder before the link arrives', () => {
    renderPlayer()
    expect(screen.getByText(/preparing video stream/i)).toBeInTheDocument()
  })

  it('shows a buffering indicator while stalled and clears on playback', async () => {
    const { videoEl } = renderPlayer()
    await waitFor(() => expect(videoEl()).not.toBeNull())
    fireEvent(videoEl(), new Event('waiting'))
    expect(screen.getByText(/buffering/i)).toBeInTheDocument()
    fireEvent(videoEl(), new Event('playing'))
    expect(screen.queryByText(/buffering/i)).not.toBeInTheDocument()
  })

  it('re-mints exactly once when the media element errors (expired link)', async () => {
    const { videoEl } = renderPlayer()
    await waitFor(() => expect(videoEl()).not.toBeNull())
    const el = videoEl() // capture: the retry swap replaces the element in-DOM
    fireEvent(el, new Event('error'))
    fireEvent(el, new Event('error'))
    const posts = () => (fetch as ReturnType<typeof vi.fn>).mock.calls.filter((c: unknown[]) => (c[1] as RequestInit | undefined)?.method === 'POST')
    await waitFor(() => expect(posts().length).toBe(2))
  })
})
