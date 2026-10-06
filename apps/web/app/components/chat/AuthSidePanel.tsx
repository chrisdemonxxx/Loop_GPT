'use client'

import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { X, Sparkles } from 'lucide-react'
import AuthForm from '../AuthForm'
import { panelRight, sheetBottom } from '../../lib/motion'

/**
 * AuthSidePanel: login/signup docked beside the chat interface (desktop) or
 * as a bottom sheet (mobile) — the chat stays visible and usable behind it,
 * so a fresh sign-in lands straight into a live workspace instead of a
 * marketing page. ONE shell mounted at a time (matchMedia, RunViewer pattern).
 */
export default function AuthSidePanel({ onClose }: { onClose: () => void }) {
  const [isDesktop, setIsDesktop] = useState(false)
  useEffect(() => {
    if (typeof window === 'undefined') return
    const mq = window.matchMedia('(min-width: 640px)')
    const apply = () => setIsDesktop(mq.matches)
    apply()
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [])

  /** Signed in: clean reload boots the authenticated chat fresh (queries,
   *  sockets, and cached state all start from a real session). */
  const authed = () => { window.location.href = '/' }

  const content = (
    <>
      <div className="shrink-0 flex items-center gap-2 px-4 py-3 border-b border-white/[0.06]">
        <div className="w-7 h-7 rounded-lg bg-[#c96442] flex items-center justify-center"><Sparkles size={13} className="text-white" /></div>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium text-slate-100">Sign in to save your work</div>
          <div className="text-[11px] text-slate-500">Chat stays open — you land right back in it.</div>
        </div>
        <button type="button" onClick={onClose} aria-label="Close sign-in panel" className="p-1.5 rounded-lg text-slate-400 hover:bg-white/[0.06]">
          <X size={16} />
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain px-4 py-4">
        <AuthForm mode="login" compact onAuthed={authed} />
      </div>
    </>
  )

  return isDesktop ? (
    <motion.div
      variants={panelRight} initial="initial" animate="animate" exit="exit"
      className="relative hidden sm:flex flex-col w-[420px] max-w-[92vw] h-dvh fixed right-0 top-0 z-40 glass-strong border-l border-white/[0.08] shadow-panel"
    >
      {content}
    </motion.div>
  ) : (
    <motion.div
      variants={sheetBottom} initial="initial" animate="animate" exit="exit"
      className="relative sm:hidden flex flex-col h-[88dvh] fixed inset-x-0 bottom-0 z-40 glass-strong rounded-t-2xl border-t border-white/[0.08] shadow-panel"
    >
      <div className="mx-auto mt-2 mb-1 w-9 h-1 rounded-full bg-white/[0.14] shrink-0" aria-hidden />
      {content}
    </motion.div>
  )
}