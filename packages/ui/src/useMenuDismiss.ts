'use client'

import { useEffect } from 'react'
import type { RefObject } from 'react'

/**
 * Shared popover dismissal: click-away (pointer down outside the referenced
 * subtree) + Escape, active only while `open` is true.
 *
 * Uses `mousedown`/`touchstart` (not `click`) so the close fires before the
 * outside control's own handler.
 */
export function useMenuDismiss(
  ref: RefObject<HTMLElement | null>,
  open: boolean,
  onClose: () => void,
) {
  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: MouseEvent | TouchEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    document.addEventListener('mousedown', onPointerDown, true)
    document.addEventListener('touchstart', onPointerDown, true)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', onPointerDown, true)
      document.removeEventListener('touchstart', onPointerDown, true)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [ref, open, onClose])
}