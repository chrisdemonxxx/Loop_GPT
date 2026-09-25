'use client'

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { X, ChevronLeft, ChevronRight, ZoomIn } from 'lucide-react'
import type { ArtifactRef } from '../../lib/stream'
import { artifactHref, useAuthedUrl } from './artifactUrl'

const MIN_SCALE = 1
const MAX_SCALE = 4

/**
 * Fullscreen image lightbox (audit P4): pinch/wheel/double-click zoom with
 * drag-to-pan when zoomed, next/prev navigation across the conversation's
 * images (buttons, arrow keys, horizontal swipe), swipe-down-to-close on
 * touch, and Escape/backdrop close. Images resolve through authed blob URLs.
 */
export default function Lightbox({
  images, startIndex = 0, onClose,
}: {
  images: ArtifactRef[]
  startIndex?: number
  onClose: () => void
}) {
  const [index, setIndex] = useState(startIndex)
  const [scale, setScale] = useState(1)
  const [tx, setTx] = useState(0)
  const [ty, setTy] = useState(0)
  const [loaded, setLoaded] = useState(false)
  const pointers = useRef(new Map<number, { x: number; y: number }>())
  const gesture = useRef<{ pinchDist: number | null; moved: boolean }>({ pinchDist: null, moved: false })
  const swipe = useRef<{ x: number; y: number } | null>(null)

  const active = images[index]
  const href = active ? artifactHref(active.url) : undefined
  const src = useAuthedUrl(href)

  // Reset zoom on image switch; keyboard navigation + Escape.
  useEffect(() => { setScale(1); setTx(0); setTy(0); setLoaded(false) }, [index])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      if (e.key === 'ArrowRight' && images.length > 1) setIndex((i) => (i + 1) % images.length)
      if (e.key === 'ArrowLeft' && images.length > 1) setIndex((i) => (i - 1 + images.length) % images.length)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [images.length, onClose])

  const zoomAround = (next: number) => {
    const clamped = Math.min(MAX_SCALE, Math.max(MIN_SCALE, next))
    if (clamped === 1) { setTx(0); setTy(0) }
    setScale(clamped)
  }

  const dist = (a: { x: number; y: number }, b: { x: number; y: number }) =>
    Math.hypot(a.x - b.x, a.y - b.y)

  const onPointerDown = (e: React.PointerEvent) => {
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    gesture.current.moved = false
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()]
      gesture.current.pinchDist = dist(a, b)
    } else {
      swipe.current = { x: e.clientX, y: e.clientY }
    }
  }

  const onPointerMove = (e: React.PointerEvent) => {
    if (!pointers.current.has(e.pointerId)) return
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (pointers.current.size >= 2 && gesture.current.pinchDist) {
      const [a, b] = [...pointers.current.values()]
      const next = dist(a, b)
      zoomAround((scale * next) / gesture.current.pinchDist)
      gesture.current.pinchDist = next
      gesture.current.moved = true
    } else if (pointers.current.size === 1) {
      const origin = swipe.current
      if (!origin) return
      const dx = e.clientX - origin.x
      const dy = e.clientY - origin.y
      if (Math.abs(dx) + Math.abs(dy) > 4) gesture.current.moved = true
      if (scale > 1) {
        setTx(dx)
        setTy(dy)
      }
    }
  }

  const onPointerUp = (e: React.PointerEvent) => {
    const origin = swipe.current
    pointers.current.delete(e.pointerId)
    if (pointers.current.size < 2) gesture.current.pinchDist = null
    swipe.current = null
    if (gesture.current.moved && origin && scale === 1) {
      const dx = e.clientX - origin.x
      const dy = e.clientY - origin.y
      // Swipe down (touch) collapses the lightbox; horizontal swipes navigate.
      if (dy > 90 && Math.abs(dy) > Math.abs(dx)) return onClose()
      if (dx < -60 && images.length > 1) return setIndex((i) => (i + 1) % images.length)
      if (dx > 60 && images.length > 1) return setIndex((i) => (i - 1 + images.length) % images.length)
    }
  }

  if (!active) return null

  // Portal to the body: mount-point transforms (panel slide-ins) would
  // otherwise become the containing block for this fixed overlay.
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
      role="dialog"
      aria-modal="true"
      aria-label={`Image viewer: ${active.name}`}
    >
      <div
        className="relative flex items-center justify-center w-full h-full touch-none select-none overflow-hidden"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onWheel={(e) => zoomAround(scale + (e.deltaY < 0 ? 0.25 : -0.25))}
        onDoubleClick={() => zoomAround(scale > 1 ? 1 : 2.5)}
      >
        {src ? (
          <img
            src={src}
            alt={active.name}
            onLoad={() => setLoaded(true)}
            draggable={false}
            className={`max-w-full max-h-full object-contain transition-opacity duration-150 ${loaded ? 'opacity-100' : 'opacity-0'}`}
            style={{ transform: `translate(${tx}px, ${ty}px) scale(${scale})`, cursor: scale > 1 ? 'grab' : 'zoom-in' }}
          />
        ) : (
          <span className="shimmer inline-block h-2.5 w-40 rounded-full" aria-hidden="true" />
        )}
      </div>

      {/* Chrome */}
      <div className="absolute top-3 right-3 flex items-center gap-2">
        <span className="text-[12px] text-slate-400 bg-black/40 rounded-full px-2.5 py-1">
          {images.length > 1 ? `${index + 1} / ${images.length}` : ''}
        </span>
        <button type="button" onClick={onClose} title="Close" aria-label="Close viewer"
          className="p-2 rounded-full bg-black/50 text-slate-200 hover:bg-black/70 transition">
          <X size={18} />
        </button>
      </div>
      {images.length > 1 && (
        <>
          <button type="button" aria-label="Previous image" title="Previous image"
            onClick={() => setIndex((i) => (i - 1 + images.length) % images.length)}
            className="absolute left-3 top-1/2 -translate-y-1/2 p-2.5 rounded-full bg-black/50 text-slate-200 hover:bg-black/70 transition">
            <ChevronLeft size={20} />
          </button>
          <button type="button" aria-label="Next image" title="Next image"
            onClick={() => setIndex((i) => (i + 1) % images.length)}
            className="absolute right-3 top-1/2 -translate-y-1/2 p-2.5 rounded-full bg-black/50 text-slate-200 hover:bg-black/70 transition">
            <ChevronRight size={20} />
          </button>
        </>
      )}
      <span className="absolute bottom-3 left-1/2 -translate-x-1/2 flex items-center gap-1.5 text-[11px] text-slate-400 bg-black/40 rounded-full px-3 py-1 pointer-events-none">
        <ZoomIn size={11} /> scroll or double-click to zoom · swipe down to close
      </span>
    </div>,
    document.body,
  )
}
