'use client'

import { useEffect, useState } from 'react'
import { FileDown, Maximize2, X, Loader2 } from 'lucide-react'
import { motion } from 'framer-motion'
import { API_URL, authHeaders } from '../../lib/api'
import { type ArtifactRef } from '../../lib/stream'
import Markdown from './Markdown'
import { downloadArtifact, isVideoArtifact, useAuthedUrl } from './artifactUrl'

/** Chat-inline artifact affordance: video player, zoomable image button, or
 * a download chip for everything else. Images open the ArtifactViewer modal. */
export function ArtifactCard({ a, onOpen }: { a: ArtifactRef; onOpen?: () => void }) {
  const href = a.url ? (a.url.startsWith('http') ? a.url : `${API_URL}${a.url}`) : undefined
  const imageSrc = useAuthedUrl(a.kind === 'image' ? href : undefined)
  const videoSrc = useAuthedUrl(isVideoArtifact(a) ? href : undefined)
  if (isVideoArtifact(a) && videoSrc) {
    return (
      <div className="group relative inline-flex max-w-md">
        <video
          src={videoSrc}
          controls
          playsInline
          preload="metadata"
          className="w-full max-h-96 rounded-2xl border border-white/10 bg-black"
        >
          <track kind="captions" />
        </video>
        <button
          type="button"
          onClick={() => downloadArtifact(a, href)}
          title="Download"
          aria-label={`Download ${a.name}`}
          className="absolute top-2 right-2 p-1.5 rounded-lg bg-black/60 text-slate-200 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition"
        >
          <FileDown size={14} />
        </button>
      </div>
    )
  }
  if (a.kind === 'image' && imageSrc) {
    return (
      <div className="group relative inline-flex">
        <button type="button" onClick={onOpen} className="block group relative">
          <img src={imageSrc} alt={a.name} className="max-w-md max-h-96 rounded-2xl border border-white/10 group-hover:border-white/20 transition" />
          <span className="absolute top-2 right-2 p-1.5 rounded-lg bg-black/50 text-slate-300 opacity-0 group-hover:opacity-100 transition">
            <Maximize2 size={13} />
          </span>
        </button>
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
      onClick={() => downloadArtifact(a, href)}
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

/** Fullscreen in-app artifact viewer: images zoom, code/markdown render. */
export function ArtifactViewer({ a, onClose }: { a: ArtifactRef; onClose: () => void }) {
  const href = a.url ? (a.url.startsWith('http') ? a.url : `${API_URL}${a.url}`) : undefined
  const viewerImage = useAuthedUrl(a.kind === 'image' ? href : undefined)
  const viewerVideo = useAuthedUrl(isVideoArtifact(a) ? href : undefined)
  const isImage = a.kind === 'image'
  const isVideo = isVideoArtifact(a)
  const isMarkdown = /\.(md|txt)$/i.test(a.name) || a.kind === 'document'
  const [textContent, setTextContent] = useState<string | null>(null)
  useEffect(() => {
    if (isImage || isVideo || !href) return
    let revoked = false
    ;(async () => {
      try {
        const res = await fetch(href, { headers: authHeaders(false) })
        if (!res.ok) return
        const text = await res.text()
        if (!revoked) setTextContent(text.slice(0, 512_000))
      } catch { /* leave the download affordance */ }
    })()
    return () => { revoked = true }
  }, [href, isImage, isVideo])
  return (
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 sm:p-8"
      onClick={onClose}
    >
      <motion.div
        initial={{ scale: 0.97, y: 8 }} animate={{ scale: 1, y: 0 }} exit={{ scale: 0.97, y: 8 }} transition={{ duration: 0.16 }}
        role="dialog" aria-modal="true" aria-label={a.name}
        ref={(node) => { if (node) (node as HTMLElement).focus() }}
        tabIndex={-1}
        onKeyDown={(e) => { if (e.key === 'Escape') onClose() }}
        className="max-w-4xl w-full max-h-full glass rounded-2xl border border-white/10 overflow-hidden flex flex-col outline-none"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-white/10">
          <div className="min-w-0">
            <div className="text-[14px] text-slate-100 truncate">{a.name}</div>
            <div className="text-[11px] uppercase tracking-wide text-slate-500">{a.kind}</div>
          </div>
          <div className="flex items-center gap-2">
            {href && (
              <button type="button" onClick={() => downloadArtifact(a, href)}
                title="Download" aria-label={`Download ${a.name}`}
                className="p-1.5 rounded-md text-slate-400 hover:text-slate-200 hover:bg-white/[0.05] transition">
                <FileDown size={15} />
              </button>
            )}
            <button type="button" onClick={onClose}
              className="p-1.5 rounded-md text-slate-400 hover:text-slate-200 hover:bg-white/[0.05] transition">
              <X size={15} />
            </button>
          </div>
        </div>
        <div className="flex-1 overflow-auto p-4">
          {isVideo && viewerVideo && (
            <video src={viewerVideo} controls playsInline preload="metadata"
              className="max-w-full rounded-xl border border-white/10 bg-black">
              <track kind="captions" />
            </video>
          )}
          {isImage && viewerImage && <img src={viewerImage} alt={a.name} className="max-w-full rounded-xl border border-white/10" />}
          {!isImage && !isVideo && textContent !== null && (isMarkdown
            ? <Markdown content={textContent} />
            : <pre className="text-[13px] leading-relaxed text-slate-200 whitespace-pre-wrap font-mono">{textContent}</pre>)}
          {!isImage && !isVideo && textContent === null && (
            <div className="flex items-center gap-2 text-slate-500 text-[13px] py-8 justify-center">
              <Loader2 size={14} className="animate-spin" /> Loading preview…
            </div>
          )}
        </div>
      </motion.div>
    </motion.div>
  )
}
