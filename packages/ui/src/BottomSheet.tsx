'use client'

import { useEffect, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { sheetBottom, scrim as scrimVariant } from './motion'
import { useFocusTrap } from './useFocusTrap'

/**
 * BottomSheet — the ONE mobile sheet primitive. Opaque surface,
 * grip handle, safe-area aware, scrim with tap-to-close, Escape to close,
 * focus trapped while open, 88dvh cap with internal scroll.
 */
export function BottomSheet({
  open,
  onClose,
  children,
  ariaLabel,
  maxHeight = '88dvh',
}: {
  open: boolean
  onClose: () => void
  children: ReactNode
  ariaLabel: string
  maxHeight?: string
}) {
  const trapRef = useFocusTrap<HTMLDivElement>(open)
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])
  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            variants={scrimVariant}
            initial="initial"
            animate="animate"
            exit="exit"
            className="fixed inset-0 z-40 bg-black/55 backdrop-blur-[2px]"
            onClick={onClose}
            aria-hidden
          />
          <motion.div
            ref={trapRef}
            tabIndex={-1}
            variants={sheetBottom}
            initial="initial"
            animate="animate"
            exit="exit"
            role="dialog"
            aria-modal="true"
            aria-label={ariaLabel}
            className="fixed inset-x-0 bottom-0 z-40 flex flex-col rounded-t-2xl border-t border-[var(--border-strong)] shadow-panel overflow-hidden outline-none"
            style={{
              maxHeight,
              background: 'var(--bg-overlay)',
              backdropFilter: 'blur(20px)',
              WebkitBackdropFilter: 'blur(20px)',
              paddingBottom: 'env(safe-area-inset-bottom, 0px)',
            }}
          >
            <button
              type="button"
              aria-label="Close sheet"
              onClick={onClose}
              className="mx-auto mt-2 mb-1 w-9 h-1.5 rounded-full bg-[var(--bg-hover-strong)] shrink-0 cursor-pointer"
            />
            <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain">{children}</div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  )
}
