'use client'

import { useEffect, useRef } from 'react'
import { isApplePlatform } from './platformKey'

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
      // Ctrl+L focuses the address bar and Ctrl+B is bold. On Windows those
      // stay with the browser; ⌘L / ⌘B still work on Apple keyboards.
      if (combo.meta && !isApplePlatform() && e.ctrlKey && !e.metaKey && /^[lb]$/i.test(e.key)) return
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
