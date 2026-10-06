'use client'

import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { X, FlaskConical, Loader2, ExternalLink, RotateCcw } from 'lucide-react'
import { API_URL, authHeaders } from '../lib/api'
import Markdown from './chat/Markdown'

export interface ResearchRunView {
  id: string
  status: 'running' | 'completed' | 'failed'
  query: string
  createdAt: string
  hasReport: boolean
  sources?: Array<{ index: number; title: string; url: string }>
  events?: Array<{ type: string; [k: string]: any }>
  report?: string
}

interface Props {
  conversationId: string | null
  onClose: () => void
}

const statusCls: Record<string, string> = {
  running: 'bg-amber-500/10 text-amber-400',
  completed: 'bg-emerald-500/10 text-emerald-400',
  failed: 'bg-rose-500/10 text-rose-400',
}

/** Research runs for the current conversation: list, resume-in-progress, and a
 * full cited report viewer. Uses the durable /api/agent/research endpoints. */
export default function ResearchPanel({ conversationId, onClose }: Props) {
  const [runs, setRuns] = useState<ResearchRunView[]>([])
  const [loading, setLoading] = useState(true)
  const [open, setOpen] = useState<ResearchRunView | null>(null)
  const [openLoading, setOpenLoading] = useState(false)

  async function load() {
    if (!conversationId) { setRuns([]); setLoading(false); return }
    setLoading(true)
    try {
      const res = await fetch(`${API_URL}/api/agent/research?conversationId=${conversationId}`, { headers: authHeaders() })
      const data = await res.json().catch(() => [])
      setRuns(Array.isArray(data) ? data : [])
    } catch { setRuns([]) } finally { setLoading(false) }
  }
  useEffect(() => { load() }, [conversationId])

  // Poll while any run is still running.
  useEffect(() => {
    if (!runs.some((r) => r.status === 'running')) return
    const t = setInterval(load, 3000)
    return () => clearInterval(t)
  }, [runs, conversationId])

  async function view(runId: string) {
    setOpenLoading(true)
    try {
      const res = await fetch(`${API_URL}/api/agent/research/${runId}`, { headers: authHeaders() })
      const run = await res.json()
      setOpen(run)
    } catch { /* ignore */ } finally { setOpenLoading(false) }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <motion.div
        initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }}
        onClick={(e) => e.stopPropagation()}
        className="glass-strong rounded-2xl w-full max-w-2xl max-h-[85vh] overflow-hidden border border-white/10 flex flex-col"
        role="dialog" aria-modal="true" aria-label="Research runs"
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-white/[0.06] shrink-0">
          <h2 className="text-base font-semibold text-slate-100 flex items-center gap-2"><FlaskConical size={15} className="text-slate-400" /> Research</h2>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-300" aria-label="Close"><X size={16} /></button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 min-h-0">
          {!conversationId && <div className="text-sm text-slate-500 text-center py-8">Open a conversation to see its research runs.</div>}
          {conversationId && loading && <div className="text-sm text-slate-500 text-center py-8">Loading runs…</div>}
          {conversationId && !loading && runs.length === 0 && (
            <div className="text-sm text-slate-500 text-center py-8">No research runs here. Start one with <code className="text-slate-400">/research</code> or the Research toggle.</div>
          )}
          <div className="space-y-2">
            {runs.map((r) => (
              <div key={r.id} className="p-3 rounded-lg border border-white/[0.06] bg-white/[0.02] flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <div className="text-sm text-slate-100 truncate">{r.query}</div>
                  <div className="text-[11px] text-slate-500 mt-0.5 flex items-center gap-2">
                    <span className={`px-1.5 py-0.5 rounded ${statusCls[r.status]}`}>{r.status}</span>
                    {r.status === 'running' && <Loader2 size={11} className="animate-spin" />}
                    <span>{new Date(r.createdAt).toLocaleString()}</span>
                    {r.sources?.length ? <span>{r.sources.length} sources</span> : null}
                  </div>
                </div>
                <button
                  onClick={() => view(r.id)}
                  disabled={openLoading}
                  className="px-2.5 py-1.5 rounded-lg text-[12px] bg-white/[0.04] text-slate-300 hover:bg-white/[0.08] transition shrink-0 flex items-center gap-1.5"
                >
                  {openLoading ? <Loader2 size={12} className="animate-spin" /> : <ExternalLink size={12} />} View
                </button>
              </div>
            ))}
          </div>

          {/* Full report viewer */}
          {open && (
            <div className="mt-4 rounded-xl border border-white/[0.08] overflow-hidden">
              <div className="flex items-center justify-between px-4 py-2.5 bg-white/[0.04] border-b border-white/[0.06]">
                <div className="text-sm font-medium text-slate-100 truncate">{open.query}</div>
                <button onClick={() => setOpen(null)} className="text-slate-500 hover:text-slate-300 shrink-0" aria-label="Close report"><X size={13} /></button>
              </div>
              <div className="p-4 max-h-[45vh] overflow-y-auto">
                {open.status === 'running' && (
                  <div className="flex items-center gap-2 text-slate-400 text-sm"><Loader2 size={13} className="animate-spin" /> Research is still running — this view updates live.</div>
                )}
                {open.report ? (
                  <Markdown content={open.report} />
                ) : (
                  <div className="text-sm text-slate-500">No report yet.</div>
                )}
                {open.sources && open.sources.length > 0 && (
                  <div className="mt-4 pt-4 border-t border-white/[0.06]">
                    <div className="text-[11px] uppercase tracking-wider text-slate-500 mb-2">Sources</div>
                    <div className="space-y-1">
                      {open.sources.map((s) => (
                        <a key={s.index} href={s.url} target="_blank" rel="noreferrer" className="flex items-center gap-2 text-[12px] text-sky-400 hover:underline">
                          [{s.index}] {s.title} <ExternalLink size={10} />
                        </a>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </motion.div>
    </div>
  )
}
