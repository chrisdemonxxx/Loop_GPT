'use client'

import { useEffect, useCallback, useRef } from 'react'

/**
 * Minimal hotkey hook: registers a global keydown listener that calls
 * handler when a matching key combination is pressed. Prevent default
 * on matched combos; skips when focus is inside an input/textarea.
 */
export function useHotkey(
  combo: { key: string; meta?: boolean; ctrl?: boolean; shift?: boolean },
  handler: (e: KeyboardEvent) => void,
) {
  const ref = useRef(handler)
  ref.current = handler

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return
      const meta = (combo.meta ?? false) ? (e.metaKey || e.ctrlKey) : true
      const ctrl = (combo.ctrl ?? false) ? (e.metaKey || e.ctrlKey) : true
      const shift = (combo.shift ?? false) ? e.shiftKey : true
      if (e.key === combo.key && meta && ctrl && shift) {
        e.preventDefault()
        ref.current(e)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [combo.key, combo.meta, combo.ctrl, combo.shift])
}
