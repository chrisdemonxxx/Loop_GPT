'use client'

import { useRef, useState, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { useMenuDismiss } from './useMenuDismiss'
import { popover, popoverUp } from './motion'

/**
 * AnchoredPopover — the ONE popover primitive. Trigger + panel with
 * the shared dismiss (click-away + Escape) and motion spec built in. New
 * menus should never hand-roll dismissal again.
 *
 * Usage:
 *   <AnchoredPopover direction="up" label="Run settings" trigger={(open) => <button>…</button>}>
 *     {(close) => <MenuItems onPick={close} />}
 *   </AnchoredPopover>
 */
export function AnchoredPopover({
  trigger,
  children,
  direction = 'down',
  className = '',
  panelClassName = '',
  ariaLabel,
}: {
  /** Render prop for the trigger; receives open state and the toggle. */
  trigger: (open: boolean, toggle: () => void) => ReactNode
  /** Panel content; receives the close function. */
  children: ReactNode | ((close: () => void) => ReactNode)
  direction?: 'up' | 'down'
  className?: string
  panelClassName?: string
  ariaLabel?: string
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const close = () => setOpen(false)
  useMenuDismiss(ref, open, close)

  return (
    <div className={`relative ${className}`} ref={ref}>
      {trigger(open, () => setOpen((v) => !v))}
      <AnimatePresence>
        {open && (
          <motion.div
            variants={direction === 'up' ? popoverUp : popover}
            initial="initial"
            animate="animate"
            exit="exit"
            role="menu"
            aria-label={ariaLabel}
            className={`composer-menu absolute z-20 ${
              direction === 'up' ? 'bottom-full mb-2' : 'top-full mt-2'
            } left-0 glass-strong rounded-xl border border-white/[0.08] overflow-hidden shadow-panel ${panelClassName}`}
          >
            {typeof children === 'function' ? children(close) : children}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}