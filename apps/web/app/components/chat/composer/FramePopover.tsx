'use client'

import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { popoverUp } from '../../../lib/motion'

/** Popover that opens just above the composer form.
 *  The form clips overflow, so an absolute menu inside it covers the textarea.
 *  This one is portaled and anchored to the form's top edge. */
export function FramePopover({
  open, onClose, anchorRef, className, label, children,
}: {
  open: boolean
  onClose: () => void
  anchorRef: RefObject<HTMLElement | null>
  className?: string
  label: string
  children: ReactNode
}) {
  const menuRef = useRef<HTMLDivElement>(null)
  const [box, setBox] = useState<{ left: number; bottom: number; maxH: number } | null>(null)

  useEffect(() => {
    if (!open) return
    const place = () => {
      const node = anchorRef.current
      const rect = (node?.closest('form') || node)?.getBoundingClientRect()
      if (!rect) return
      setBox({
        left: Math.max(8, rect.left),
        bottom: Math.max(8, window.innerHeight - rect.top + 8),
        maxH: Math.max(160, Math.min(280, rect.top - 16)),
      })
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [open, anchorRef])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: Event) => {
      const target = e.target as Node
      if (anchorRef.current?.contains(target) || menuRef.current?.contains(target)) return
      onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      onClose()
    }
    document.addEventListener('mousedown', onPointerDown, true)
    document.addEventListener('touchstart', onPointerDown, true)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', onPointerDown, true)
      document.removeEventListener('touchstart', onPointerDown, true)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [open, onClose, anchorRef])

  if (typeof document === 'undefined') return null
  return createPortal(
    <AnimatePresence>
      {open && box && (
        <motion.div
          ref={menuRef}
          role="menu"
          aria-label={label}
          variants={popoverUp}
          initial="initial"
          animate="animate"
          exit="exit"
          style={{ position: 'fixed', left: box.left, bottom: box.bottom, maxHeight: box.maxH }}
          className={className}
        >
          {children}
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  )
}
