'use client'

import { useEffect, useId, useRef, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { useFocusTrap } from './useFocusTrap'
import { scrim as scrimVariant } from './motion'
import { btnDanger, btnGhost, btnPrimary } from './primitives'

/** Open dialogs, innermost last: Escape closes only the top one. */
const escapeStack: Array<{ current: () => void }> = []

function useEscapeStack(active: boolean, onClose: () => void) {
  const handler = useRef(onClose)
  handler.current = onClose
  useEffect(() => {
    if (!active) return
    const entry = { current: () => handler.current() }
    escapeStack.push(entry)
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || escapeStack[escapeStack.length - 1] !== entry) return
      // Claim it so page-level Escape handlers (Settings, composer) skip it.
      e.preventDefault()
      e.stopPropagation()
      entry.current()
    }
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('keydown', onKey, true)
      const at = escapeStack.indexOf(entry)
      if (at >= 0) escapeStack.splice(at, 1)
    }
  }, [active])
}

const SIZES = { sm: 'max-w-sm', md: 'max-w-md', lg: 'max-w-lg', xl: 'max-w-2xl', full: 'max-w-none' } as const

/**
 * The one modal: scrim (tap to close), focus trap with focus restore,
 * Escape (innermost dialog first), and dialog semantics. Pass `title` for a
 * visible heading wired to aria-labelledby, or `ariaLabel` for a headless
 * panel (command palette, lightbox).
 */
export function Dialog({
  open, onClose, title, description, ariaLabel, children, footer,
  size = 'md', role = 'dialog', align = 'center', closeOnScrim = true,
  className = '', panelClassName, scrimClassName = 'bg-black/60 backdrop-blur-sm', zIndex = 'z-50',
  panelProps,
}: {
  open: boolean
  onClose: () => void
  title?: ReactNode
  description?: ReactNode
  ariaLabel?: string
  children?: ReactNode
  footer?: ReactNode
  size?: keyof typeof SIZES
  role?: 'dialog' | 'alertdialog'
  /** `top` suits palettes; `bottom` turns into a sheet on phones. */
  align?: 'center' | 'top' | 'bottom'
  closeOnScrim?: boolean
  className?: string
  /** Replaces the default panel surface entirely (full-bleed viewers). */
  panelClassName?: string
  scrimClassName?: string
  zIndex?: string
  panelProps?: Record<string, string | undefined>
}) {
  const titleId = useId()
  const descId = useId()
  const trapRef = useFocusTrap<HTMLDivElement>(open)
  useEscapeStack(open, onClose)
  const placement = align === 'top'
    ? 'items-start pt-[15vh]'
    : align === 'bottom'
      ? 'items-end sm:items-center'
      : 'items-center'
  return (
    <AnimatePresence>
      {open && (
        <motion.div
          variants={scrimVariant}
          initial="initial"
          animate="animate"
          exit="exit"
          className={`fixed inset-0 ${zIndex} flex justify-center p-4 pt-[max(1rem,env(safe-area-inset-top))] pb-[max(1rem,env(safe-area-inset-bottom))] ${placement} ${scrimClassName}`}
          onClick={closeOnScrim ? onClose : undefined}
        >
          <motion.div
            ref={trapRef}
            tabIndex={-1}
            role={role}
            aria-modal="true"
            aria-labelledby={title ? titleId : undefined}
            aria-label={title ? undefined : ariaLabel}
            aria-describedby={description ? descId : undefined}
            initial={{ opacity: 0, scale: 0.97, y: 6 }}
            animate={{ opacity: 1, scale: 1, y: 0, transition: { duration: 0.16, ease: [0.22, 1, 0.36, 1] } }}
            exit={{ opacity: 0, scale: 0.97, y: 6, transition: { duration: 0.12 } }}
            onClick={(e) => e.stopPropagation()}
            className={panelClassName ?? `w-full ${SIZES[size]} max-h-full overflow-y-auto rounded-2xl border border-[var(--border-strong)] bg-[var(--bg-panel)] shadow-panel p-5 outline-none ${className}`}
            {...panelProps}
          >
            {title && <h2 id={titleId} className="text-ui-base font-semibold text-[var(--ink-primary)]">{title}</h2>}
            {description && <div id={descId} className="mt-1.5 text-ui-sm text-[var(--ink-secondary)] leading-relaxed">{description}</div>}
            {children}
            {footer && <div className="mt-5 flex flex-wrap justify-end gap-2">{footer}</div>}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

/**
 * Confirm a consequential action. `danger` swaps the confirm button to the
 * destructive fill and uses alertdialog semantics. `children` hosts extra
 * fields (a reason, a type-to-confirm input) between the copy and buttons.
 */
export function ConfirmDialog({
  open, title, body, confirmLabel, cancelLabel = 'Cancel', busyLabel = 'Working…',
  tone = 'default', busy = false, confirmDisabled = false, onConfirm, onCancel, children, ariaLabel,
}: {
  open: boolean
  title: ReactNode
  body?: ReactNode
  confirmLabel: string
  cancelLabel?: string
  busyLabel?: string
  tone?: 'default' | 'danger'
  busy?: boolean
  confirmDisabled?: boolean
  onConfirm: () => void
  onCancel: () => void
  children?: ReactNode
  /** Overrides the accessible name (defaults to the title). */
  ariaLabel?: string
}) {
  const danger = tone === 'danger'
  return (
    <Dialog
      open={open}
      onClose={busy ? () => {} : onCancel}
      role={danger ? 'alertdialog' : 'dialog'}
      title={ariaLabel ? undefined : title}
      ariaLabel={ariaLabel}
      size="sm"
      footer={(
        <>
          <button type="button" className={btnGhost} onClick={onCancel} disabled={busy}>{cancelLabel}</button>
          <button
            type="button"
            className={danger ? btnDanger : btnPrimary}
            disabled={busy || confirmDisabled}
            onClick={onConfirm}
          >
            {busy ? busyLabel : confirmLabel}
          </button>
        </>
      )}
    >
      {ariaLabel && <h2 className="text-ui-base font-semibold text-[var(--ink-primary)]">{title}</h2>}
      {body && <div className="mt-1.5 text-ui-sm text-[var(--ink-secondary)] leading-relaxed">{body}</div>}
      {children}
    </Dialog>
  )
}
