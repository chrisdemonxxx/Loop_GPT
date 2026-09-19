'use client'

import { useEffect, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Cpu, Terminal, Circle, Loader2, CheckCircle2, XCircle, FileDown, Image as ImageIcon, X } from 'lucide-react'
import { API_URL } from '../lib/api'
import type { ArtifactRef } from '../lib/stream'

export interface LiveStep {
  index: number
  kind: 'text' | 'tool'
  text: string
  tool?: { name: string; args: any; source?: string; result?: string; isError?: boolean }
}

interface Props {
  running: boolean
  status: string
  steps: LiveStep[]
  artifacts: ArtifactRef[]
  toolCount: number
  onClose?: () => void
}

/**
 * The "Agent Computer" — a Manus-style live activity panel. Streams the agent's
 * tool calls as a terminal feed and surfaces generated artifacts in real time.
 */
export default function AgentComputer({ running, status, steps, artifacts, toolCount, onClose }: Props) {
  const feedRef = useRef<HTMLDivElement>(null)
  const toolSteps = steps.filter((s) => s.kind === 'tool' && s.tool)

  useEffect(() => {
    feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight, behavior: 'smooth' })
  }, [steps, status])

  const idle = !running && toolSteps.length === 0 && artifacts.length === 0

  return (
    <div className="glass-strong rounded-2xl h-full flex flex-col overflow-hidden shadow-panel">
      {/* Header */}
      <div className="flex items-center gap-2.5 px-4 py-3 border-b border-white/5">
        <div className="relative">
          <Cpu size={18} className="text-neon-violet" />
          {running && <span className="absolute -right-1 -top-1 w-2 h-2 rounded-full bg-neon-green animate-pulseGlow" />}
        </div>
        <div className="flex-1">
          <div className="text-sm font-semibold text-slate-100">Agent Computer</div>
          <div className="text-[11px] text-slate-500">{running ? 'working…' : 'idle'} · {toolCount} tools</div>
        </div>
        <span className={`text-[10px] px-2 py-0.5 rounded-full border ${running ? 'border-neon-green/40 text-neon-green' : 'border-white/10 text-slate-500'}`}>
          {running ? 'LIVE' : 'READY'}
        </span>
        {onClose && (
          <button onClick={onClose} className="lg:hidden p-1 -mr-1 rounded-lg hover:bg-white/5 text-slate-400" title="Close"><X size={16} /></button>
        )}
      </div>

      {/* Terminal feed */}
      <div ref={feedRef} className="terminal flex-1 overflow-y-auto px-4 py-3 text-[12px] leading-relaxed">
        {idle && (
          <div className="h-full flex flex-col items-center justify-center text-center text-slate-600 gap-2">
            <Terminal size={26} className="text-slate-700" />
            <p className="text-xs max-w-[200px]">Tool calls, searches, and terminal output stream here in real time as the agent works.</p>
          </div>
        )}

        <AnimatePresence initial={false}>
          {toolSteps.map((s) => (
            <motion.div
              key={s.index}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.22 }}
              className="mb-2.5"
            >
              <div className="flex items-start gap-2">
                <span className="text-neon-green select-none">$</span>
                <span className="text-neon-cyan">{s.tool!.name}</span>
                <span className="text-slate-500 break-all">{compactArgs(s.tool!.args)}</span>
              </div>
              <div className="flex items-start gap-2 pl-4 mt-0.5">
                {!s.tool!.result ? (
                  <span className="flex items-center gap-1.5 text-slate-500"><Loader2 size={11} className="animate-spin" /> running…</span>
                ) : s.tool!.isError ? (
                  <span className="flex items-start gap-1.5 text-rose-400"><XCircle size={12} className="mt-0.5 shrink-0" /><span className="whitespace-pre-wrap break-all">{clip(s.tool!.result)}</span></span>
                ) : (
                  <span className="flex items-start gap-1.5 text-slate-300"><CheckCircle2 size={12} className="mt-0.5 shrink-0 text-neon-green" /><span className="whitespace-pre-wrap break-all">{clip(s.tool!.result)}</span></span>
                )}
              </div>
            </motion.div>
          ))}
        </AnimatePresence>

        {running && (
          <div className="flex items-center gap-2 text-slate-500">
            <span className="text-neon-green">$</span>
            <span className="cursor">{status || 'thinking'}</span>
          </div>
        )}
      </div>

      {/* Artifacts strip */}
      {artifacts.length > 0 && (
        <div className="border-t border-white/5 p-3 space-y-2 max-h-56 overflow-y-auto">
          <div className="text-[11px] uppercase tracking-wide text-slate-500 flex items-center gap-1.5"><Circle size={7} className="fill-neon-fuchsia text-neon-fuchsia" /> Outputs</div>
          <div className="grid grid-cols-1 gap-2">
            {artifacts.map((a) => <ArtifactChip key={a.id} a={a} />)}
          </div>
        </div>
      )}
    </div>
  )
}

function ArtifactChip({ a }: { a: ArtifactRef }) {
  const href = a.url ? (a.url.startsWith('http') ? a.url : `${API_URL}${a.url}`) : undefined
  if (a.kind === 'image' && href) {
    return <img src={href} alt={a.name} className="w-full rounded-lg border border-white/10" />
  }
  return (
    <a href={href} target="_blank" rel="noreferrer" className="flex items-center gap-2 px-3 py-2 rounded-lg glass hover:accent-ring transition text-sm text-slate-200">
      {a.kind === 'image' ? <ImageIcon size={15} className="text-neon-cyan" /> : <FileDown size={15} className="text-neon-violet" />}
      <span className="truncate flex-1">{a.name}</span>
      <span className="text-[10px] uppercase text-slate-500">{a.kind}</span>
    </a>
  )
}

function compactArgs(args: any): string {
  try {
    const s = JSON.stringify(args)
    return s.length > 80 ? s.slice(0, 80) + '…' : s
  } catch {
    return ''
  }
}
function clip(s: string, n = 400): string {
  if (!s) return ''
  return s.length > n ? s.slice(0, n) + ' …' : s
}
