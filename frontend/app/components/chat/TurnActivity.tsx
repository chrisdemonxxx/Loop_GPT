'use client'

import { useEffect, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  ChevronDown, Loader2, Wrench, CheckCircle2, XCircle, Clock,
  MousePointerClick, AlertCircle, RotateCcw, ListChecks,
} from 'lucide-react'
import { API_URL, authHeaders } from '../../lib/api'
import type { LiveStep, StoredStep, PendingApproval } from './types'

/** Format a wall-clock duration compactly: 480ms / 1.2s / 2m 05s. */
export function fmtDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const m = Math.floor(ms / 60_000)
  const s = Math.round((ms % 60_000) / 1000)
  return `${m}m ${String(s).padStart(2, '0')}s`
}

function fmtTime(ts?: number): string {
  if (!ts) return ''
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
}

/** Compact one-line argument summary for a tool card. */
function argSummary(args: any): string {
  try {
    const entries = Object.entries(args || {})
    if (!entries.length) return ''
    return entries.slice(0, 2).map(([k, v]) => `${k}: ${String(JSON.stringify(v)).replace(/^"|"$/g, '').slice(0, 40)}`).join('  ')
  } catch { return '' }
}

type TurnState = 'running' | 'waiting' | 'error' | 'done'

interface TurnActivityProps {
  /** Live turn only: the run is streaming right now. */
  running?: boolean
  status?: string
  /** Live steps (live turn) — the source of truth while streaming. */
  liveSteps?: LiveStep[]
  /** Persisted steps (stored turn, from message.metadata.steps). */
  storedSteps?: StoredStep[]
  pendingApproval?: PendingApproval | null
  onApprove?: () => void
  onDeny?: () => void
  /** Shown in the error state so a failed turn can be re-sent in one click. */
  onRetry?: () => void
  /** Available-tool count (live turn header popover). */
  toolCount?: number
  onOpenTools?: () => void
}

/**
 * Inline agent activity for one assistant turn — the Claude-web pattern:
 * a one-line summary ("Ran 4 steps") with a status icon that expands into the
 * full tool-call timeline. Auto-expands while the run streams, auto-collapses
 * when it finishes; each step carries its wall-clock duration, and a failed
 * turn surfaces a Retry button.
 */
export default function TurnActivity({
  running = false, status = '', liveSteps = [], storedSteps = [], pendingApproval,
  onApprove, onDeny, onRetry, toolCount, onOpenTools,
}: TurnActivityProps) {
  const isLive = liveSteps.length > 0 || running || !!pendingApproval
  const liveTools = liveSteps.filter((s) => s.kind === 'tool' && s.tool)
  const stepCount = isLive ? liveTools.length : storedSteps.length

  const [open, setOpen] = useState(running)
  // Auto-expand at run start; auto-collapse on completion (audit P1 fix).
  const prevRunning = useRef(running)
  useEffect(() => {
    if (running && !prevRunning.current) setOpen(true)
    if (!running && prevRunning.current) setOpen(false)
    prevRunning.current = running
  }, [running])

  const [expanded, setExpanded] = useState<Set<number>>(new Set())
  const toggleExpand = (index: number) =>
    setExpanded((prev) => { const next = new Set(prev); if (next.has(index)) next.delete(index); else next.add(index); return next })

  const hasError = isLive ? liveTools.some((s) => s.tool?.isError) : false
  const turnState: TurnState = pendingApproval ? 'waiting' : running ? 'running' : hasError ? 'error' : 'done'

  const stateMeta: Record<TurnState, { label: string; icon: any; text: string }> = {
    running: { label: 'Running', icon: Loader2, text: 'text-amber-400' },
    waiting: { label: 'Waiting for approval', icon: MousePointerClick, text: 'text-[#e79d7f]' },
    error: { label: 'Error', icon: AlertCircle, text: 'text-rose-400' },
    done: { label: '', icon: CheckCircle2, text: 'text-slate-400' },
  }
  const meta = stateMeta[turnState]
  const StateIcon = meta.icon

  // Nothing to summarize (stored turn without persisted steps).
  if (stepCount === 0 && !pendingApproval) return null

  return (
    // The block eases in (150ms fade — no scale pop, audit P5); individual
    // step cards crossfade separately below. MotionConfig reducedMotion="user"
    // makes this instant for reduced-motion users.
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.15 }}
      className="rounded-xl border border-white/[0.06] bg-white/[0.02] overflow-hidden"
    >
      {/* Summary line — one row per turn; click to expand/collapse. */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-white/[0.03] transition"
      >
        <StateIcon size={13} className={`${meta.text} shrink-0 ${running ? 'animate-spin' : ''}`} />
        <span className={`text-[12px] ${turnState === 'done' ? 'text-slate-400' : meta.text} font-medium`}>
          {turnState === 'running' && status ? status : `Ran ${stepCount} step${stepCount === 1 ? '' : 's'}`}
        </span>
        {turnState === 'waiting' && <span className="text-[11px] text-slate-400">· approve to continue</span>}
        {turnState === 'error' && <span className="text-[11px] text-slate-400">· a step failed</span>}
        <span className="flex-1" />
        <ChevronDown size={13} className={`text-slate-500 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {/* Retry affordance on a failed turn (audit P1). */}
      {turnState === 'error' && onRetry && (
        <div className="flex items-center gap-2 px-3 pb-2 -mt-0.5">
          <button
            type="button"
            onClick={onRetry}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-white/10 text-[12px] text-slate-300 hover:bg-white/[0.05] hover:border-white/20 transition"
          >
            <RotateCcw size={12} /> Retry
          </button>
        </div>
      )}

      {/* Expanded: the full per-step timeline. */}
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18 }}
            className="overflow-hidden"
          >
            <div className="border-t border-white/[0.05] px-2.5 py-2 space-y-1.5 max-h-72 overflow-y-auto text-[12px] leading-relaxed">
              {/* Approval card (live only). */}
              {pendingApproval && (
                <motion.div
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="p-3 rounded-xl border border-[#c96442]/30 bg-[#c96442]/[0.07]"
                >
                  <div className="flex items-center gap-1.5 text-[12px] font-medium text-[#e79d7f] mb-1.5">
                    <MousePointerClick size={12} /> Tool requires approval
                  </div>
                  <div className="text-[12px] text-slate-300 mb-2.5">
                    Approve <code className="text-slate-100 bg-white/[0.07] px-1.5 py-0.5 rounded font-mono text-[11px]">{pendingApproval.toolName}</code> with the provided arguments?
                  </div>
                  <div className="flex gap-2">
                    <button type="button" onClick={onApprove} className="flex-1 px-3 py-1.5 rounded-lg bg-[#c96442] text-white text-[12px] font-medium hover:bg-[#b5593a] transition">Approve</button>
                    <button type="button" onClick={onDeny} className="flex-1 px-3 py-1.5 rounded-lg border border-white/10 text-slate-300 text-[12px] hover:bg-white/5 transition">Deny</button>
                  </div>
                </motion.div>
              )}

              {isLive ? (
                <AnimatePresence initial={false}>
                  {liveTools.map((s) => (
                    <StepCard
                      key={s.index}
                      index={s.index}
                      name={s.tool!.name}
                      args={s.tool!.args}
                      result={s.tool!.result}
                      isError={s.tool!.isError}
                      durationMs={s.tool!.durationMs}
                      ts={s.ts}
                      running={running}
                      isOpen={expanded.has(s.index)}
                      onToggle={() => toggleExpand(s.index)}
                    />
                  ))}
                </AnimatePresence>
              ) : (
                storedSteps.map((s, i) => (
                  <StepCard
                    key={`${s.tool}-${i}`}
                    index={i}
                    name={s.tool}
                    args={s.args}
                    result={s.result}
                    isError={false}
                    durationMs={undefined}
                    ts={undefined}
                    running={false}
                    isOpen={expanded.has(i)}
                    onToggle={() => toggleExpand(i)}
                  />
                ))
              )}

              {/* Live status tail while streaming. */}
              {running && (
                <div className="flex items-center gap-2 text-slate-400 px-0.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
                  <span className="cursor text-[11px]">{status || 'thinking'}</span>
                </div>
              )}

              {/* Available tools popover trigger (live only). */}
              {isLive && typeof toolCount === 'number' && <ToolsFooter toolCount={toolCount} onOpenTools={onOpenTools} />}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  )
}

/** One collapsible tool-call card: status icon, name, arg summary, duration. */
function StepCard({
  index, name, args, result, isError, durationMs, ts, running, isOpen, onToggle,
}: {
  index: number
  name: string
  args: any
  result?: string
  isError?: boolean
  durationMs?: number
  ts?: number
  running: boolean
  isOpen: boolean
  onToggle: () => void
}) {
  const resultText = result || ''
  return (
    <motion.div
      initial={{ opacity: 0, y: 6, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ duration: 0.15 }}
      className={`rounded-xl border overflow-hidden ${isError ? 'border-rose-500/20 bg-rose-500/[0.04]' : 'border-white/[0.06] bg-white/[0.02]'}`}
    >
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center gap-2 px-2.5 py-2 text-left hover:bg-white/[0.03] transition"
        aria-expanded={isOpen}
        aria-label={`Toggle step details for ${name}`}
      >
        {!result && running ? (
          <Loader2 size={12} className="text-amber-400 animate-spin shrink-0" />
        ) : isError ? (
          <XCircle size={12} className="text-rose-400 shrink-0" />
        ) : (
          <CheckCircle2 size={12} className="text-emerald-400 shrink-0" />
        )}
        <span className="font-mono text-[11.5px] text-slate-200 shrink-0">{name}</span>
        <span className="text-[11px] text-slate-400 truncate flex-1">{argSummary(args)}</span>
        {durationMs !== undefined && <span className="text-[10px] text-slate-400 shrink-0">{fmtDuration(durationMs)}</span>}
        {ts && <span className="text-[10px] text-slate-500 shrink-0 flex items-center gap-0.5"><Clock size={9} /> {fmtTime(ts)}</span>}
        <ChevronDown size={12} className={`text-slate-500 shrink-0 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
      </button>
      {isOpen && (
        <div className="border-t border-white/[0.05] px-2.5 py-2">
          <div className="text-[10px] uppercase tracking-wide text-slate-500 mb-1">Input</div>
          <pre className="text-[10.5px] font-mono text-slate-400 whitespace-pre-wrap break-all mb-2">{JSON.stringify(args ?? {}, null, 1).slice(0, 1200)}</pre>
          {resultText && (
            <>
              <div className="text-[10px] uppercase tracking-wide text-slate-500 mb-1">Output</div>
              <pre className={`text-[10.5px] font-mono whitespace-pre-wrap break-all ${isError ? 'text-rose-300' : 'text-slate-300'}`}>{resultText.slice(0, 2000)}{(resultText.length > 2000 ? '\n…' : '')}</pre>
            </>
          )}
        </div>
      )}
      {!isOpen && !result && running && (
        <div className="px-2.5 pb-2 text-[11px] text-slate-400">running…</div>
      )}
    </motion.div>
  )
}

/** Live-only footer: clickable available-tools count with popover list. */
function ToolsFooter({ toolCount, onOpenTools }: { toolCount: number; onOpenTools?: () => void }) {
  const [show, setShow] = useState(false)
  const [tools, setTools] = useState<Array<{ name: string; description: string }>>([])
  useEffect(() => {
    if (!show || tools.length) return
    fetch(`${API_URL}/api/agent/tools`, { headers: authHeaders() })
      .then((r) => r.json())
      .then((rows) => setTools(Array.isArray(rows) ? rows : []))
      .catch(() => setTools([]))
  }, [show, tools.length])
  return (
    <div className="pt-1">
      <button
        onClick={() => setShow((v) => !v)}
        title="Available tools — click to view"
        aria-expanded={show}
        className="flex items-center gap-1 px-2 py-1 rounded-full border border-white/10 text-[11px] text-slate-400 hover:text-slate-200 hover:border-white/20 transition"
      >
        <ListChecks size={11} /> {toolCount} tools
      </button>
      {show && (
        <div className="mt-1.5 rounded-xl border border-white/[0.06] bg-white/[0.02] max-h-40 overflow-y-auto">
          {tools.length === 0 && <div className="px-3 py-2 text-[12px] text-slate-400">Loading tools…</div>}
          {tools.map((t) => (
            <div key={t.name} className="px-3 py-1.5 flex items-start gap-2">
              <Wrench size={11} className="text-slate-500 mt-0.5 shrink-0" />
              <div className="min-w-0">
                <span className="font-mono text-[11.5px] text-slate-300">{t.name}</span>
                <span className="block text-[11px] text-slate-400 truncate">{t.description}</span>
              </div>
            </div>
          ))}
          {onOpenTools && (
            <button onClick={() => { setShow(false); onOpenTools() }} className="w-full px-3 py-2 text-[12px] text-[#e79d7f] hover:bg-white/[0.04] transition text-left border-t border-white/[0.05]">
              Manage permissions in Settings →
            </button>
          )}
        </div>
      )}
    </div>
  )
}
