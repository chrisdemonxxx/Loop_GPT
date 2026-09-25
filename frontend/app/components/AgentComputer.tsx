'use client'

import { useEffect, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Activity, ChevronDown, FileDown, Image as ImageIcon, Loader2, Wrench,
  CheckCircle2, XCircle, X, Clock, MousePointerClick, AlertCircle, ListChecks,
} from 'lucide-react'
import { API_URL, authHeaders } from '../lib/api'
import type { ArtifactRef } from '../lib/stream'

export interface LiveStep {
  index: number
  kind: 'text' | 'tool'
  text: string
  ts?: number
  tool?: { name: string; args: any; source?: string; result?: string; isError?: boolean }
}

interface Props {
  running: boolean
  status: string
  steps: LiveStep[]
  artifacts: ArtifactRef[]
  toolCount: number
  pendingApproval?: { toolName: string; approve: (ok: boolean) => Promise<any> } | null
  onApprove?: () => void
  onDeny?: () => void
  onClose?: () => void
  /** Open Settings → Tools (from the clickable tool count). */
  onOpenTools?: () => void
}

type PanelState = 'idle' | 'thinking' | 'running' | 'waiting' | 'error'

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

/** Group steps into "turns": a new group starts at each user-visible gap in ts. */
function groupSteps(toolSteps: LiveStep[]): LiveStep[][] {
  const groups: LiveStep[][] = []
  let lastTs = 0
  for (const s of toolSteps) {
    if (!groups.length || (s.ts && lastTs && s.ts - lastTs > 120_000)) groups.push([])
    groups[groups.length - 1].push(s)
    if (s.ts) lastTs = s.ts
  }
  return groups
}

/**
 * The "Agent Computer" — a modern live activity feed (Claude Code / Manus
 * style): five status states, collapsible tool-call cards with timestamps and
 * success/fail indicators, a clickable tool count, and a consistent empty state.
 */
export default function AgentComputer({ running, status, steps, artifacts, toolCount, pendingApproval, onApprove, onDeny, onClose, onOpenTools }: Props) {
  const feedRef = useRef<HTMLDivElement>(null)
  const [showTools, setShowTools] = useState(false)
  const [tools, setTools] = useState<Array<{ name: string; description: string }>>([])
  const [expanded, setExpanded] = useState<Set<number>>(new Set())
  const toolSteps = steps.filter((s) => s.kind === 'tool' && s.tool)

  useEffect(() => {
    feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight, behavior: 'smooth' })
  }, [steps, status])

  useEffect(() => {
    if (!showTools || tools.length) return
    fetch(`${API_URL}/api/agent/tools`, { headers: authHeaders() })
      .then((r) => r.json())
      .then((rows) => setTools(Array.isArray(rows) ? rows : []))
      .catch(() => setTools([]))
  }, [showTools, tools.length])

  const hasError = toolSteps.some((s) => s.tool?.isError)
  const panelState: PanelState = pendingApproval
    ? 'waiting'
    : running
      ? (status ? 'thinking' : 'running')
      : hasError
        ? 'error'
        : 'idle'

  const stateMeta: Record<PanelState, { label: string; dot: string; icon: any; text: string }> = {
    idle: { label: 'Idle', dot: 'bg-slate-500', icon: Activity, text: 'text-slate-400' },
    thinking: { label: 'Thinking', dot: 'bg-amber-400 animate-pulseGlow', icon: Loader2, text: 'text-amber-400' },
    running: { label: 'Running tool', dot: 'bg-neon-green animate-pulseGlow', icon: Wrench, text: 'text-neon-green' },
    waiting: { label: 'Waiting for input', dot: 'bg-[#c96442] animate-pulseGlow', icon: MousePointerClick, text: 'text-[#e79d7f]' },
    error: { label: 'Error', dot: 'bg-rose-400', icon: AlertCircle, text: 'text-rose-400' },
  }
  const meta = stateMeta[panelState]
  const StateIcon = meta.icon
  const idle = !running && toolSteps.length === 0 && artifacts.length === 0

  const toggleExpand = (index: number) =>
    setExpanded((prev) => { const next = new Set(prev); if (next.has(index)) next.delete(index); else next.add(index); return next })

  const groups = groupSteps(toolSteps)

  return (
    <div className="glass-strong rounded-2xl h-full flex flex-col overflow-hidden shadow-panel">
      {/* Header — live animated status + clickable tool count */}
      <div className="relative flex items-center gap-2.5 px-4 py-3 border-b border-white/5">
        <span className="relative flex items-center justify-center w-6 h-6">
          <StateIcon size={15} className={`${meta.text} ${running || panelState === 'waiting' ? 'animate-pulse' : ''}`} />
          <span className={`absolute -right-0.5 -top-0.5 w-2 h-2 rounded-full ${meta.dot}`} />
        </span>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold text-slate-100">Agent activity</div>
          <div className={`text-[11px] ${meta.text} flex items-center gap-1`}>{meta.label}{status && running ? ` · ${status}` : ''}</div>
        </div>
        <button
          onClick={() => setShowTools((v) => !v)}
          title="Available tools — click to view"
          aria-expanded={showTools}
          className="flex items-center gap-1 px-2 py-1 rounded-full border border-white/10 text-[11px] text-slate-400 hover:text-slate-200 hover:border-white/20 transition"
        >
          <ListChecks size={11} /> {toolCount} tools
        </button>
        {onClose && (
          <button onClick={onClose} className="lg:hidden p-1 -mr-1 rounded-lg hover:bg-white/5 text-slate-400" title="Close"><X size={16} /></button>
        )}
      </div>

      {/* Tool list popover (clickable tool count) */}
      {showTools && (
        <div className="border-b border-white/5 max-h-52 overflow-y-auto">
          {tools.length === 0 && <div className="px-4 py-2.5 text-[12px] text-slate-500">Loading tools…</div>}
          {tools.map((t) => (
            <div key={t.name} className="px-4 py-1.5 flex items-start gap-2">
              <Wrench size={11} className="text-slate-600 mt-0.5 shrink-0" />
              <div className="min-w-0">
                <span className="font-mono text-[11.5px] text-slate-300">{t.name}</span>
                <span className="block text-[11px] text-slate-500 truncate">{t.description}</span>
              </div>
            </div>
          ))}
          {onOpenTools && (
            <button onClick={() => { setShowTools(false); onOpenTools() }} className="w-full px-4 py-2 text-[12px] text-[#e79d7f] hover:bg-white/[0.04] transition text-left border-t border-white/5">
              Manage permissions in Settings →
            </button>
          )}
        </div>
      )}

      {/* Activity feed — timeline of collapsible tool-call cards */}
      <div ref={feedRef} className="flex-1 overflow-y-auto px-4 py-3 text-[12px] leading-relaxed">
        {idle && (
          <div className="h-full flex flex-col items-center justify-center text-center text-slate-600 gap-2.5">
            <div className="w-12 h-12 rounded-2xl bg-white/[0.03] border border-white/[0.06] flex items-center justify-center">
              <Activity size={22} className="text-slate-600" />
            </div>
            <p className="text-xs font-medium text-slate-400">The agent works here</p>
            <p className="text-[11px] max-w-[220px] leading-relaxed">Tool calls, searches, and results appear as a live timeline while the agent thinks.</p>
          </div>
        )}

        <AnimatePresence initial={false}>
          {groups.map((group, gi) => (
            <motion.div key={gi} initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="mb-3">
              {groups.length > 1 && (
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-[10px] uppercase tracking-widest text-slate-600">Step {gi + 1}</span>
                  <span className="flex-1 h-px bg-white/[0.05]" />
                </div>
              )}
              <div className="space-y-1.5">
                {group.map((s) => {
                  const tool = s.tool!
                  const isOpen = expanded.has(s.index)
                  const resultText = tool.result || ''
                  return (
                    <motion.div
                      key={s.index}
                      initial={{ opacity: 0, y: 6 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ duration: 0.2 }}
                      className={`rounded-xl border overflow-hidden ${tool.isError ? 'border-rose-500/20 bg-rose-500/[0.04]' : 'border-white/[0.06] bg-white/[0.02]'}`}
                    >
                      <button
                        type="button"
                        onClick={() => toggleExpand(s.index)}
                        className="w-full flex items-center gap-2 px-2.5 py-2 text-left hover:bg-white/[0.03] transition"
                        aria-expanded={isOpen}
                      >
                        {!tool.result && running ? (
                          <Loader2 size={12} className="text-amber-400 animate-spin shrink-0" />
                        ) : tool.isError ? (
                          <XCircle size={12} className="text-rose-400 shrink-0" />
                        ) : (
                          <CheckCircle2 size={12} className="text-emerald-400 shrink-0" />
                        )}
                        <span className="font-mono text-[11.5px] text-slate-200 shrink-0">{tool.name}</span>
                        <span className="text-[11px] text-slate-500 truncate flex-1">{argSummary(tool.args)}</span>
                        {s.ts && <span className="text-[10px] text-slate-600 shrink-0 flex items-center gap-0.5"><Clock size={9} /> {fmtTime(s.ts)}</span>}
                        <ChevronDown size={12} className={`text-slate-600 shrink-0 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
                      </button>
                      {isOpen && (
                        <div className="border-t border-white/[0.05] px-2.5 py-2">
                          <div className="text-[10px] uppercase tracking-wide text-slate-600 mb-1">Input</div>
                          <pre className="text-[10.5px] font-mono text-slate-400 whitespace-pre-wrap break-all mb-2">{JSON.stringify(tool.args ?? {}, null, 1).slice(0, 1200)}</pre>
                          {resultText && (
                            <>
                              <div className="text-[10px] uppercase tracking-wide text-slate-600 mb-1">Output</div>
                              <pre className={`text-[10.5px] font-mono whitespace-pre-wrap break-all ${tool.isError ? 'text-rose-300' : 'text-slate-300'}`}>{resultText.slice(0, 2000)}{(resultText.length > 2000 ? '\n…' : '')}</pre>
                            </>
                          )}
                        </div>
                      )}
                      {!isOpen && !tool.result && running && (
                        <div className="px-2.5 pb-2 text-[11px] text-slate-500">running…</div>
                      )}
                    </motion.div>
                  )
                })}
              </div>
            </motion.div>
          ))}
        </AnimatePresence>

        {/* Approval card */}
        {pendingApproval && (
          <motion.div
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            className="mb-2.5 p-3 rounded-xl border border-[#c96442]/30 bg-[#c96442]/[0.07]"
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

        {/* Live thinking line */}
        {running && (
          <div className="flex items-center gap-2 text-slate-500">
            <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
            <span className="cursor">{status || 'thinking'}</span>
          </div>
        )}
      </div>

      {/* Artifacts strip */}
      {artifacts.length > 0 && (
        <div className="border-t border-white/5 p-3 space-y-2 max-h-56 overflow-y-auto">
          <div className="text-[11px] uppercase tracking-wide text-slate-500 flex items-center gap-1.5">
            <ImageIcon size={11} className="text-slate-600" /> Outputs
          </div>
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
    <a href={href} target="_blank" rel="noreferrer" className="flex items-center gap-2 px-3 py-2 rounded-lg border border-white/[0.06] bg-white/[0.02] hover:bg-white/[0.05] transition text-sm text-slate-200">
      {a.kind === 'image' ? <ImageIcon size={15} className="text-slate-500" /> : <FileDown size={15} className="text-slate-500" />}
      <span className="truncate flex-1">{a.name}</span>
      <span className="text-[10px] uppercase text-slate-500">{a.kind}</span>
    </a>
  )
}
