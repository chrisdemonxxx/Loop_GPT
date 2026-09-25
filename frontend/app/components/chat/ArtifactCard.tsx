'use client'

import { useState } from 'react'
import { FileDown, Maximize2 } from 'lucide-react'
import { API_URL } from '../../lib/api'
import { type ArtifactRef } from '../../lib/stream'
import { downloadArtifact, isVideoArtifact, useAuthedUrl } from './artifactUrl'
import VideoPlayer from './VideoPlayer'

/** Chat-inline artifact affordance: streaming video player, zoomable image
 * button, or a download chip for everything else. Cards open the right-hand
 * artifacts panel via `onOpen` when provided. */
export function ArtifactCard({ a, onOpen }: { a: ArtifactRef; onOpen?: () => void }) {
  const href = a.url ? (a.url.startsWith('http') ? a.url : `${API_URL}${a.url}`) : undefined
  const imageSrc = useAuthedUrl(a.kind === 'image' ? href : undefined)
  const [imgLoaded, setImgLoaded] = useState(false)
  if (isVideoArtifact(a)) {
    // Range-capable signed streaming (audit P3) — no whole-file blob download.
    return (
      <div className="group relative inline-flex max-w-md w-full">
        <VideoPlayer a={a} />
        <button
          type="button"
          onClick={() => downloadArtifact(a, href)}
          title="Download"
          aria-label={`Download ${a.name}`}
          className="absolute top-2 right-11 p-1.5 rounded-lg bg-black/60 text-slate-200 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition"
        >
          <FileDown size={14} />
        </button>
      </div>
    )
  }
  if (a.kind === 'image') {
    return (
      <div className="group relative inline-flex">
        {imageSrc ? (
          <button type="button" onClick={onOpen} className="block group relative">
            {/* Sized shimmer reserves the row while the authed blob loads
                (lazy + async keep it off the critical path). */}
            {!imgLoaded && <span className="absolute inset-0 rounded-2xl shimmer -z-10" aria-hidden="true" />}
            <img
              src={imageSrc}
              alt={a.name}
              loading="lazy"
              decoding="async"
              onLoad={() => setImgLoaded(true)}
              className={`max-w-md max-h-96 rounded-2xl border border-white/10 group-hover:border-white/20 transition-opacity duration-150 ${imgLoaded ? 'opacity-100' : 'opacity-0'}`}
            />
            <span className="absolute top-2 right-2 p-1.5 rounded-lg bg-black/50 text-slate-300 opacity-0 group-hover:opacity-100 transition">
              <Maximize2 size={13} />
            </span>
          </button>
        ) : (
          <div className="w-64 h-44 rounded-2xl border border-white/[0.06] shimmer" aria-label={`Loading ${a.name}`} />
        )}
        <button
          type="button"
          onClick={() => downloadArtifact(a, href)}
          title="Download"
          aria-label={`Download ${a.name}`}
          className="absolute bottom-2 right-2 p-1.5 rounded-lg bg-black/50 text-slate-300 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition"
        >
          <FileDown size={13} />
        </button>
      </div>
    )
  }
  return (
    <button
      type="button"
      onClick={onOpen || (() => downloadArtifact(a, href))}
      className="inline-flex items-center gap-2 px-3 py-2 rounded-xl glass hover:border-white/15 hover:bg-white/[0.06] transition text-[13px] text-left"
    >
      <FileDown size={14} className="text-[#c96442] shrink-0" />
      <span className="min-w-0">
        <span className="block text-slate-200 truncate">{a.name}</span>
        <span className="block text-[10px] uppercase text-slate-500">{a.kind}</span>
      </span>
    </button>
  )
}

