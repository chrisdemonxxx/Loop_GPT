'use client'

import type { ReactNode } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { sheetBottom, scrim as scrimVariant } from '../../lib/motion'

/**
 * BottomSheet — the ONE mobile sheet primitive (Phase 4). Opaque surface,
 * grip handle, safe-area aware, scrim with tap-to-close, Escape to close,
 * 88dvh cap with internal scroll. Replaces the per-component translucent
 * sheets that bled text through (Phase-0 finding).
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
            variants={sheetBottom}
            initial="initial"
            animate="animate"
            exit="exit"
            role="dialog"
            aria-modal="true"
            aria-label={ariaLabel}
            className="fixed inset-x-0 bottom-0 z-40 flex flex-col rounded-t-2xl border-t border-white/[0.08] shadow-panel overflow-hidden"
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
              className="mx-auto mt-2 mb-1 w-9 h-1.5 rounded-full bg-white/[0.16] shrink-0 cursor-pointer"
            />
            <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain">{children}</div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  )
}
