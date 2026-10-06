'use client'

import { useCallback, useEffect, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Keyboard } from 'lucide-react'
import { useHotkey } from '../lib/useHotkey'
import { modLabel } from '../lib/platformKey'

function shortcutRows() {
  const mod = modLabel()
  return [
    { keys: `${mod} K`, label: 'Command palette' },
    { keys: `${mod} L`, label: 'New conversation' },
    { keys: `${mod} B`, label: 'Toggle sidebar' },
    { keys: `${mod} Enter`, label: 'Send message' },
    { keys: `${mod} ↑ / ${mod} ↓`, label: 'Conversation history' },
    { keys: '↑ / ↓', label: 'Prompt history' },
    { keys: `${mod} Z / ${mod} Y`, label: 'Undo / redo' },
    { keys: 'Esc', label: 'Close popover / Cancel' },
    { keys: '/', label: 'Commands (in chat box)' },
  ]
}

interface Props {
  /** When provided, the sheet is controlled by the parent and the `?` hotkey
   *  is bound to `onOpenChange(true)`. When omitted, the sheet manages its
   *  own open state via the `?` key. */
  open?: boolean
  onOpenChange?: (open: boolean) => void
}

export function ShortcutSheet({ open: controlledOpen, onOpenChange }: Props = {}) {
  const [internalOpen, setInternalOpen] = useState(false)
  const isControlled = controlledOpen !== undefined && onOpenChange !== undefined
  const open = isControlled ? controlledOpen : internalOpen
  const setOpen = useCallback((next: boolean) => {
    if (isControlled) onOpenChange!(next)
    else setInternalOpen(next)
  }, [isControlled, onOpenChange])

  useHotkey({ key: '?' }, () => setOpen(true))
  // Capture so Escape still closes the sheet while the composer textarea is focused.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      setOpen(false)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, setOpen])

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.12 }}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
          onClick={() => setOpen(false)}
        >
          <motion.div
            initial={{ scale: 0.97 }} animate={{ scale: 1 }} exit={{ scale: 0.97 }} transition={{ duration: 0.12 }}
            className="w-full max-w-sm glass-strong rounded-2xl border border-white/[0.08] overflow-hidden shadow-2xl p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2 mb-4">
              <Keyboard size={16} className="text-slate-500" />
              <span className="text-[14px] font-medium text-slate-200">Keyboard shortcuts</span>
            </div>
            <div className="space-y-2">
              {shortcutRows().map((s) => (
                <div key={s.keys} className="flex items-center justify-between text-[13px]">
                  <span className="text-slate-400">{s.label}</span>
                  <kbd className="font-mono text-[12px] text-slate-500 bg-white/[0.04] px-2 py-0.5 rounded">{s.keys}</kbd>
                </div>
              ))}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
