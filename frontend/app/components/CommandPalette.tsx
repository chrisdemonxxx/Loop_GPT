'use client'

import { useState, useMemo } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { MessageSquare, Search, Settings, LogOut, Sparkles, PanelRightClose } from 'lucide-react'
import { useHotkey } from '../lib/useHotkey'
import { useI18n } from '../lib/i18n'

interface Cmd {
  key: string
  label: string
  icon: any
  action: () => void
}

export function CommandPalette({
  onNewSession,
  onToggleSidebar,
  onOpenSettings,
  onLogout,
}: {
  onNewSession: () => void
  onToggleSidebar: () => void
  onOpenSettings: () => void
  onLogout: () => void
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const { t } = useI18n()

  const cmds: Cmd[] = useMemo(() => [
    { key: 'new', label: 'New session', icon: MessageSquare, action: onNewSession },
    { key: 'search', label: 'Search chats', icon: Search, action: onToggleSidebar },
    { key: 'sidebar', label: 'Toggle sidebar', icon: PanelRightClose, action: onToggleSidebar },
    { key: 'settings', label: 'Settings', icon: Settings, action: onOpenSettings },
    { key: 'logout', label: 'Sign out', icon: LogOut, action: onLogout },
  ], [onNewSession, onToggleSidebar, onOpenSettings, onLogout])

  const filtered = useMemo(
    () => cmds.filter((c) => c.label.toLowerCase().includes(query.toLowerCase())),
    [cmds, query],
  )

  useHotkey({ key: 'k', meta: true }, () => setOpen(true))
  useHotkey({ key: 'Escape' }, () => { if (open) { setOpen(false); setQuery('') } })

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.12 }}
          className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh] bg-black/60 backdrop-blur-sm"
          onClick={() => { setOpen(false); setQuery('') }}
        >
          <motion.div
            initial={{ scale: 0.97, y: -10 }} animate={{ scale: 1, y: 0 }} exit={{ scale: 0.97, y: -10 }} transition={{ duration: 0.12 }}
            className="w-full max-w-lg glass-strong rounded-2xl border border-white/[0.08] overflow-hidden shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2 px-4 py-3 border-b border-white/[0.06]">
              <Search size={14} className="text-slate-500 shrink-0" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Type a command or search…"
                className="flex-1 bg-transparent text-[14px] text-slate-200 placeholder-slate-600 focus:outline-none"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && filtered[0]) {
                    filtered[0].action()
                    setOpen(false)
                    setQuery('')
                  }
                }}
              />
              <span className="text-[10px] uppercase text-slate-600 bg-white/[0.04] px-1.5 py-0.5 rounded">ESC</span>
            </div>
            <div className="py-1 max-h-64 overflow-y-auto">
              {filtered.map((c) => {
                const Icon = c.icon
                return (
                  <button
                    key={c.key}
                    type="button"
                    onClick={() => { c.action(); setOpen(false); setQuery('') }}
                    className="w-full flex items-center gap-3 px-4 py-2.5 text-[13px] text-slate-200 hover:bg-white/[0.05] text-left transition"
                  >
                    <Icon size={15} className="text-slate-500 shrink-0" />
                    <span>{c.label}</span>
                  </button>
                )
              })}
              {filtered.length === 0 && (
                <p className="px-4 py-6 text-center text-[12px] text-slate-600">No matching commands</p>
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
