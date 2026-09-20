'use client'

import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Keyboard } from 'lucide-react'
import { useHotkey } from '../lib/useHotkey'

const SHORTCUTS = [
  { keys: '⌘K', label: 'Command palette' },
  { keys: '⌘L', label: 'New conversation' },
  { keys: '⌘B', label: 'Toggle sidebar' },
  { keys: '⌘⏎', label: 'Send message' },
  { keys: '⌘↑ / ⌘↓', label: 'Conversation history' },
  { keys: 'Esc', label: 'Close popover / Cancel' },
  { keys: '/', label: 'Commands (in chat box)' },
]

export function ShortcutSheet() {
  const [open, setOpen] = useState(false)
  useHotkey({ key: '?' }, () => setOpen(true))
  useHotkey({ key: 'Escape' }, () => { if (open) { setOpen(false) } })

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
              {SHORTCUTS.map((s) => (
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
