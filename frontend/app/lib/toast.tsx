'use client'

import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { CheckCircle2, AlertCircle, Info, X } from 'lucide-react'

/**
 * Toast notifications (audit §8-19: replaces the single statusMsg-style
 * transient strings). Success / error / info pills, stacked bottom-center,
 * auto-dismiss with manual close. Consumed via useToast().
 */

type ToastKind = 'success' | 'error' | 'info'

interface Toast {
  id: number
  kind: ToastKind
  message: string
}

interface ToastApi {
  /** Show a toast; auto-dismisses after ~3.4s. */
  push: (kind: ToastKind, message: string) => void
}

const ToastCtx = createContext<ToastApi | null>(null)

let toastSeq = 0

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>())

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
    const timer = timers.current.get(id)
    if (timer) { clearTimeout(timer); timers.current.delete(id) }
  }, [])

  const push = useCallback((kind: ToastKind, message: string) => {
    const id = ++toastSeq
    setToasts((prev) => [...prev.slice(-3), { id, kind, message }])
    timers.current.set(id, setTimeout(() => dismiss(id), 3400))
  }, [dismiss])

  return (
    <ToastCtx.Provider value={{ push }}>
      {children}
      <ToastViewport toasts={toasts} onDismiss={dismiss} />
    </ToastCtx.Provider>
  )
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastCtx)
  // Non-fatal default outside the provider (tests, standalone pages).
  if (!ctx) return { push: () => {} }
  return ctx
}

function ToastViewport({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: number) => void }) {
  if (typeof document === 'undefined') return null
  return createPortal(
    <div className="fixed bottom-24 left-1/2 -translate-x-1/2 z-[60] flex flex-col items-center gap-2 pointer-events-none">
      <AnimatePresence initial={false}>
        {toasts.map((t) => (
          <motion.div
            key={t.id}
            initial={{ opacity: 0, y: 8, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.98 }}
            transition={{ duration: 0.15 }}
            role="status"
            className={`pointer-events-auto flex items-center gap-2 pl-3 pr-2 py-2 rounded-xl glass border shadow-panel max-w-[86vw] ${
              t.kind === 'success' ? 'border-emerald-400/25' : t.kind === 'error' ? 'border-rose-400/25' : 'border-white/[0.08]'
            }`}
          >
            {t.kind === 'success' && <CheckCircle2 size={14} className="text-emerald-400 shrink-0" />}
            {t.kind === 'error' && <AlertCircle size={14} className="text-rose-400 shrink-0" />}
            {t.kind === 'info' && <Info size={14} className="text-slate-400 shrink-0" />}
            <span className="text-[12.5px] text-slate-200">{t.message}</span>
            <button type="button" onClick={() => onDismiss(t.id)} aria-label="Dismiss notification"
              className="p-1 rounded text-slate-500 hover:text-slate-300 hover:bg-white/5 transition">
              <X size={12} />
            </button>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>,
    document.body,
  )
}
