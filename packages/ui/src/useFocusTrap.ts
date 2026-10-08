'use client'

import { useEffect, useRef } from 'react'

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'textarea:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

/**
 * Keep Tab inside the dialog while `active`, and restore focus to the
 * element that opened it. Escape stays with the dialog's own handler so a
 * nested sheet can claim it first.
 */
export function useFocusTrap<T extends HTMLElement>(active: boolean) {
  const ref = useRef<T>(null)
  useEffect(() => {
    if (!active) return
    const root = ref.current
    if (!root) return
    const previously = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const nodes = () => Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE))
      .filter((el) => !el.hasAttribute('disabled') && el.getAttribute('aria-hidden') !== 'true')
    const initial = nodes()[0]
    if (initial) initial.focus()
    else root.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return
      const list = nodes()
      if (!list.length) {
        e.preventDefault()
        return
      }
      const firstEl = list[0]
      const lastEl = list[list.length - 1]
      const current = document.activeElement
      const inside = current instanceof Node && root.contains(current)
      if (e.shiftKey && (current === firstEl || !inside)) {
        e.preventDefault()
        lastEl.focus()
      } else if (!e.shiftKey && (current === lastEl || !inside)) {
        e.preventDefault()
        firstEl.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      previously?.focus?.()
    }
  }, [active])
  return ref
}
