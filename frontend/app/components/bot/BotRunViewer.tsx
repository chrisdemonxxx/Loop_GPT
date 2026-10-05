'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  X, Monitor, Loader2, AlertCircle, CheckCircle2, Terminal,
  Hand, Bot,
} from 'lucide-react'
import {
  getBotTask, getBotComputer, setBotTakeover, streamBotRun,
  type BotEvent, type BotComputer, type BotTaskDetail,
} from '../../lib/bot'
import { panelRight, sheetBottom, scrim as scrimVariant } from '../../lib/motion'

/**
 * Loop Bot run viewer: the live trace (SSE — replay + live attach, never
 * polling) plus the dedicated computer's noVNC view with the takeover
 * handshake. Right-dock on desktop, bottom sheet on mobile.
 */
export default function BotRunViewer({ taskId, onClose }: { taskId: string; onClose: () => void }) {
  const [task, setTask] = useState<BotTaskDetail | null>(null)
  const [runId, setRunId] = useState<string | null>(null)
  const [events, setEvents] = useState<BotEvent[]>([])
  const [live, setLive] = useState(false)
  const [computer, setComputer] = useState<BotComputer | null>(null)
  const [loadError, setLoadError] = useState('')
  const [confirmTakeover, setConfirmTakeover] = useState(false)
  const [takeoverBusy, setTakeoverBusy] = useState(false)
  const [tab, setTab] = useState<'trace' | 'computer'>('trace')
  const traceEndRef = useRef<HTMLDivElement>(null)

  // Load the task, then follow its latest run (SSE, not polling).
  useEffect(() => {
    let stop: (() => void) | null = null
    let cancelled = false
    ;(async () => {
      try {
        const detail = await getBotTask(taskId)
        if (cancelled) return
        setTask(detail)
        const latest = detail.runs?.[0]
        if (!latest) { setLoadError('No run yet — the worker picks tasks up every few seconds.'); return }
        setRunId(latest.id)
        setLive(latest.status === 'running')
        stop = streamBotRun(
          latest.id,
          (event) => { setEvents((prev) => [...prev.slice(-399), event]); if (event.type === 'final') setLive(false) },
          () => setLive(false),
          (msg) => { setLoadError(msg); setLive(false) },
        )
        const comp = await getBotComputer(latest.id).catch(() => null)
        if (!cancelled && comp?.sandboxId) setComputer(comp)
      } catch (err: any) {
        if (!cancelled) setLoadError(err?.message || 'Could not load the run.')
      }
    })()
    return () => { cancelled = true; stop?.() }
  }, [taskId])

  // Refresh computer metadata while the run is live (minutes tick up).
  useEffect(() => {
    if (!runId || !live || !computer) return
    const t = setInterval(async () => {
      const comp = await getBotComputer(runId).catch(() => null)
      if (comp?.sandboxId) setComputer(comp)
    }, 15_000)
    return () => clearInterval(t)
  }, [runId, live, computer])

  useEffect(() => {
    traceEndRef.current?.scrollIntoView({ behavior: 'instant' as ScrollBehavior, block: 'end' })
  }, [events])

  const takeover = async (seize: boolean) => {
    if (!runId) return
    setTakeoverBusy(true)
    try {
      const r = await setBotTakeover(runId, seize)
      setComputer((cur) => cur ? { ...cur, takeoverRequested: r.takeoverRequested, interactiveUrl: r.interactiveUrl } : cur)
      setConfirmTakeover(false)
    } finally {
      setTakeoverBusy(false)
    }
  }

  const lines = useMemo(() => events.filter((e) => e.type !== 'done'), [events])

  const content = (
    <div className="flex flex-col h-full min-h-0">
      {/* Header */}
      <div className="shrink-0 flex items-center gap-2 px-4 py-3 border-b border-white/[0.06]">
        <Bot size={15} className="text-[var(--accent-text)] shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium text-slate-100 truncate">{task?.goal || 'Loop Bot run'}</div>
          <div className="text-[11px] text-slate-500 flex items-center gap-2">
            {live ? <span className="flex items-center gap-1"><Loader2 size={10} className="animate-spin" /> running</span>
              : task?.runs?.[0] ? <span>{task.runs[0].status}</span> : null}
            {computer?.minutes != null && <span>{computer.minutes} VM min</span>}
            {task?.kind === 'scheduled' && <span>every {task.schedule}</span>}
          </div>
        </div>
        <button type="button" onClick={onClose} aria-label="Close run viewer" className="p-1.5 rounded-lg text-slate-400 hover:bg-white/[0.06]">
          <X size={16} />
        </button>
      </div>

      {/* Tabs (computer only when one exists) */}
      <div className="shrink-0 flex border-b border-white/[0.06] text-[12px]">
        {(['trace', ...(computer ? ['computer' as const] : [])] as const).map((id) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id as 'trace' | 'computer')}
            className={`flex-1 py-2 capitalize transition ${tab === id ? 'text-slate-100 border-b-2 border-[var(--accent)]' : 'text-slate-500 hover:text-slate-300'}`}
          >
            {id === 'computer' ? <span className="inline-flex items-center gap-1"><Monitor size={11} /> Computer</span> : <span className="inline-flex items-center gap-1"><Terminal size={11} /> Trace</span>}
          </button>
        ))}
      </div>

      {loadError && (
        <div className="m-3 flex items-center gap-2 rounded-lg border border-rose-400/25 bg-rose-500/[0.07] px-3 py-2 text-[12px] text-rose-200">
          <AlertCircle size={13} className="shrink-0" /> {loadError}
        </div>
      )}

      {/* Trace */}
      {tab === 'trace' && (
        <div className="flex-1 overflow-y-auto min-h-0 px-3 py-2 font-mono text-[11.5px] leading-relaxed">
          {lines.length === 0 && !loadError && (
            <div className="flex items-center gap-2 text-slate-500 px-1 py-2"><Loader2 size={12} className="animate-spin" /> attaching…</div>
          )}
          {lines.map((e, i) => <TraceLine key={i} event={e} />)}
          <div ref={traceEndRef} />
        </div>
      )}

      {/* Computer */}
      {tab === 'computer' && computer && (
        <div className="flex-1 min-h-0 flex flex-col">
          <div className="shrink-0 flex items-center gap-2 px-3 py-2 text-[11px] text-slate-500 border-b border-white/[0.06]">
            <span className={`w-1.5 h-1.5 rounded-full ${computer.active ? 'bg-emerald-400' : 'bg-slate-600'}`} aria-hidden />
            <span className="font-mono truncate">{computer.sandboxId}</span>
            {computer.minutes != null && <span className="ml-auto tabular-nums">{computer.minutes} min</span>}
            {computer.active && !computer.takeoverRequested && (
              <button
                type="button"
                onClick={() => setConfirmTakeover(true)}
                className="flex items-center gap-1 px-2 py-1 rounded-lg bg-white/[0.05] text-slate-200 hover:bg-white/[0.09] transition"
              >
                <Hand size={11} /> Take over
              </button>
            )}
          </div>

          {computer.takeoverRequested && (
            <div className="shrink-0 flex items-center gap-2 px-3 py-2 bg-amber-500/10 border-b border-amber-400/20 text-[12px] text-amber-200">
              <Hand size={12} className="shrink-0" />
              <span className="flex-1">You&apos;re driving — the agent is paused.</span>
              <button type="button" onClick={() => void takeover(false)} disabled={takeoverBusy} className="px-2 py-1 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 transition">
                Release
              </button>
            </div>
          )}

          <div className="flex-1 min-h-0 bg-black">
            {computer.viewUrl ? (
              <iframe
                src={(computer.takeoverRequested && computer.interactiveUrl) || computer.viewUrl}
                title="Loop Bot computer"
                className="w-full h-full border-0"
                allow="clipboard-read; clipboard-write"
              />
            ) : (
              <div className="h-full flex items-center justify-center text-slate-600 text-[12px]">stream unavailable</div>
            )}
          </div>
        </div>
      )}

      {/* Takeover confirmation (product decision: always confirm) */}
      <AnimatePresence>
        {confirmTakeover && (
          <motion.div variants={scrimVariant} initial="initial" animate="animate" exit="exit"
            className="absolute inset-0 z-10 flex items-center justify-center bg-black/60 backdrop-blur-[2px] p-4"
            onClick={() => setConfirmTakeover(false)}>
            <motion.div
              role="alertdialog" aria-modal="true" aria-label="Take over the computer"
              initial={{ scale: 0.96, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.96, opacity: 0 }}
              transition={{ duration: 0.15, ease: 'easeOut' }}
              className="glass-strong rounded-xl border border-white/[0.08] shadow-panel p-4 w-full max-w-xs"
              onClick={(e) => e.stopPropagation()}>
              <div className="text-[14px] font-medium text-slate-100">Take the wheel?</div>
              <p className="mt-1 text-[12.5px] text-slate-500">The agent pauses while you drive its computer. Release anytime — it auto-releases after 10 minutes.</p>
              <div className="mt-4 flex justify-end gap-2">
                <button type="button" onClick={() => setConfirmTakeover(false)} className="px-3 py-1.5 rounded-lg text-[12.5px] text-slate-300 hover:bg-white/[0.06] transition">Cancel</button>
                <button
                  type="button"
                  onClick={() => void takeover(true)}
                  disabled={takeoverBusy}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12.5px] font-medium text-white bg-[var(--accent)] hover:bg-[var(--accent-hover)] transition disabled:opacity-50"
                >
                  {takeoverBusy ? <Loader2 size={12} className="animate-spin" /> : <Hand size={12} />} Take over
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )

  return (
    <>
      {/* Desktop: right dock. Mobile: bottom sheet. */}
      <motion.div
        variants={panelRight} initial="initial" animate="animate" exit="exit"
        className="relative hidden sm:flex flex-col w-[460px] max-w-[92vw] h-dvh fixed right-0 top-0 z-40 glass-strong border-l border-white/[0.08] shadow-panel"
      >
        {content}
      </motion.div>
      <motion.div
        variants={sheetBottom} initial="initial" animate="animate" exit="exit"
        className="relative sm:hidden flex flex-col h-[88dvh] fixed inset-x-0 bottom-0 z-40 glass-strong rounded-t-2xl border-t border-white/[0.08] shadow-panel"
      >
        <div className="mx-auto mt-2 mb-1 w-9 h-1 rounded-full bg-white/[0.14] shrink-0" aria-hidden />
        {content}
      </motion.div>
    </>
  )
}

/** One trace line, colored by event kind (drop-in from the admin console). */
function TraceLine({ event }: { event: BotEvent }) {
  switch (event.type) {
    case 'status':
    case 'warming':
      return <div className="text-slate-500 py-0.5">· {event.message}</div>
    case 'tool_call':
      return <div className="text-sky-300/90 py-0.5">▸ {event.name}{event.args ? <span className="text-slate-600"> {truncate(JSON.stringify(event.args), 90)}</span> : null}</div>
    case 'tool_output':
      return <div className="text-slate-600 py-0.5 truncate">│ {truncate(event.chunk || '', 120)}</div>
    case 'tool_result':
      return <div className={`py-0.5 ${event.isError ? 'text-rose-300' : 'text-slate-400'}`}>└ {event.isError ? 'failed' : 'done'}{event.content ? <span className="text-slate-600"> — {truncate(event.content, 110)}</span> : null}</div>
    case 'artifact':
      return <div className="text-emerald-300/90 py-0.5">✦ created {event.artifact?.name}</div>
    case 'final':
      return <div className="text-emerald-300 py-0.5 flex items-center gap-1"><CheckCircle2 size={11} /> {truncate(event.content || 'done', 160)}</div>
    case 'error':
      return <div className="text-rose-300 py-0.5">⚠ {event.message}</div>
    default:
      return null
  }
}

function truncate(s: string, n: number) { return s.length > n ? s.slice(0, n - 1) + '…' : s }
