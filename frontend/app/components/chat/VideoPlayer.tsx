'use client'

import { useEffect, useRef, useState } from 'react'
import { Loader2, PictureInPicture2 } from 'lucide-react'
import type { ArtifactRef } from '../../lib/stream'
import { useSignedArtifactUrl, isVideoArtifact } from './artifactUrl'

/**
 * Authed video player (audit P3). Streams from a short-lived signed URL so
 * the native element does real HTTP byte-range requests (instant playback
 * start, streaming seeks) instead of the old blob-download-then-play flow.
 * Adds a buffering indicator, a first-frame poster via `preload="metadata"`,
 * and a Picture-in-Picture control where the engine supports it.
 */
export default function VideoPlayer({ a, className }: { a: ArtifactRef; className?: string }) {
  const { url, retry } = useSignedArtifactUrl(isVideoArtifact(a) ? a : undefined)
  const videoRef = useRef<HTMLVideoElement>(null)
  const [buffering, setBuffering] = useState(true)
  const [pipActive, setPipActive] = useState(false)
  const retriedRef = useRef(false)

  const pipSupported = typeof document !== 'undefined' && 'pictureInPictureEnabled' in document && document.pictureInPictureEnabled

  useEffect(() => {
    const video = videoRef.current
    if (!video || !('pictureInPictureElement' in document)) return
    const onEnter = () => setPipActive(true)
    const onLeave = () => setPipActive(false)
    video.addEventListener('enterpictureinpicture', onEnter)
    video.addEventListener('leavepictureinpicture', onLeave)
    return () => {
      video.removeEventListener('enterpictureinpicture', onEnter)
      video.removeEventListener('leavepictureinpicture', onLeave)
    }
  }, [])

  const togglePip = async () => {
    const video = videoRef.current
    if (!video) return
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture()
      else await video.requestPictureInPicture()
    } catch { /* engine refused (e.g. metadata not loaded yet) */ }
  }

  if (!url) {
    return (
      <div className={`flex items-center gap-2 justify-center py-10 text-[12px] text-slate-500 ${className || ''}`}>
        <Loader2 size={14} className="animate-spin" /> Preparing video stream…
      </div>
    )
  }

  return (
    <div className={`group relative ${className || ''}`}>
      <video
        ref={videoRef}
        src={url}
        controls
        playsInline
        // The metadata preload gives the player its first-frame poster and
        // the byte ranges needed to render it — without downloading the file.
        preload="metadata"
        className="w-full max-h-96 rounded-2xl border border-white/10 bg-black"
        onWaiting={() => setBuffering(true)}
        onStalled={() => setBuffering(true)}
        onPlaying={() => setBuffering(false)}
        onCanPlay={() => setBuffering(false)}
        onError={() => {
          // Signed links are short-lived; a stale link gets one re-mint.
          if (!retriedRef.current) { retriedRef.current = true; retry() }
        }}
      >
        <track kind="captions" />
      </video>

      {/* Buffering indicator */}
      {buffering && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none rounded-2xl">
          <span className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-black/60 text-slate-300 text-[12px]">
            <Loader2 size={13} className="animate-spin" /> Buffering…
          </span>
        </div>
      )}

      {/* Picture-in-Picture control (where the engine supports it) */}
      {pipSupported && (
        <button
          type="button"
          onClick={togglePip}
          title={pipActive ? 'Exit Picture-in-Picture' : 'Picture-in-Picture'}
          aria-label={pipActive ? 'Exit Picture-in-Picture' : 'Picture-in-Picture'}
          className={`absolute top-2 right-2 p-1.5 rounded-lg bg-black/60 text-slate-200 transition ${pipActive ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100'}`}
        >
          <PictureInPicture2 size={14} />
        </button>
      )}
    </div>
  )
}
