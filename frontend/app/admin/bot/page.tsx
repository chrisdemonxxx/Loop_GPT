'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import {
  ArrowLeft, Bot, Loader2, MonitorPlay, Play, Plus, RefreshCw, XCircle,
  HandMetal, MonitorOff, TerminalSquare,
} from 'lucide-react'
import { apiFetch } from '../../lib/api'

interface BotTask {
  id: string
  kind: string
  goal: string
  status: string
  schedule?: string | null
  model?: string | null
  priority: number
  attempts: number
  failures: number
  nextAttemptAt: string
  cancelRequested: boolean
  lastErrorCode?: string | null
  createdAt: string
  runs?: Array<{ id: string; status: string; error?: string | null; startedAt: string; completedAt?: string | null }>
}

interface RunView {
  id: string
  taskId: string
  status: string
  events: Array<{ type: string; message?: string; text?: string; name?: string; content?: string }>
  result?: string
  error?: string
  startedAt: string
  completedAt?: string
}

interface ComputerInfo {
  active: boolean
  sandboxId: string
  viewUrl: string | null
  interactiveUrl: string | null
  takeoverRequested: boolean
  minutes: number | null
}

const STATUS_COLOR: Record<string, string> = {
  queued: 'text-amber-300', processing: 'text-sky-300', succeeded: 'text-emerald-300',
  dead_letter: 'text-rose-400', cancelled: 'text-slate-500', running: 'text-sky-300',
  completed: 'text-emerald-300', failed: 'text-rose-400',
}

export default function AdminBotPage() {
  const [tasks, setTasks] = useState<BotTask[]>([])
  const [error, setError] = useState('')
  const [goal, setGoal] = useState('')
  const [schedule, setSchedule] = useState('')
  const [maxSteps, setMaxSteps] = useState(16)
  const [computer, setComputer] = useState(false)
  const [ttl, setTtl] = useState(30)
  const [submitting, setSubmitting] = useState(false)

  const [selected, setSelected] = useState<BotTask | null>(null)
  const [run, setRun] = useState<RunView | null>(null)
  const [computerInfo, setComputerInfo] = useState<ComputerInfo | null>(null)
  const [takeoverBusy, setTakeoverBusy] = useState(false)
  const feedRef = useRef<HTMLDivElement>(null)

  const refresh = useCallback(async () => {
    try {
      const data = await apiFetch<{ tasks: BotTask[] }>('/api/admin/bot/tasks?limit=50')
      setTasks(data.tasks || [])
      setError('')
    } catch (e: any) { setError(e.message) }
  }, [])

  useEffect(() => { refresh(); const t = setInterval(refresh, 5000); return () => clearInterval(t) }, [refresh])

  // Poll the selected task's latest run + its computer session.
  useEffect(() => {
    if (!selected) { setRun(null); setComputerInfo(null); return }
    let stop = false
    const tick = async () => {
      try {
        const detail = await apiFetch<BotTask>(`/api/admin/bot/tasks/${selected.id}`)
        if (stop) return
        setSelected(detail)
        const latest = detail.runs?.[0]
        if (latest) {
          const rv = await apiFetch<RunView>(`/api/admin/bot/runs/${latest.id}`)
          if (!stop) setRun(rv)
          try {
            const ci = await apiFetch<ComputerInfo>(`/api/admin/bot/runs/${latest.id}/computer`)
            if (!stop) setComputerInfo(ci)
          } catch { if (!stop) setComputerInfo(null) }
        }
      } catch { /* task may be gone */ }
    }
    tick()
    const t = setInterval(tick, 2500)
    return () => { stop = true; clearInterval(t) }
  }, [selected?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight }) }, [run?.events?.length])

  const enqueue = async () => {
    if (!goal.trim() || submitting) return
    setSubmitting(true)
    try {
      await apiFetch('/api/admin/bot/tasks', {
        method: 'POST',
        body: JSON.stringify({
          goal: goal.trim(),
          kind: schedule ? 'scheduled' : 'ops',
          ...(schedule ? { schedule } : {}),
          maxSteps,
          ...(computer ? { computer: { enabled: true, ttlMinutes: ttl } } : {}),
        }),
      })
      setGoal('')
      refresh()
    } catch (e: any) { setError(e.message) } finally { setSubmitting(false) }
  }

  const cancel = async (id: string) => {
    try { await apiFetch(`/api/admin/bot/tasks/${id}/cancel`, { method: 'POST', body: '{}' }); refresh() } catch (e: any) { setError(e.message) }
  }

  const takeover = async (on: boolean) => {
    if (!run || takeoverBusy) return
    setTakeoverBusy(true)
    try {
      const res = await apiFetch<{ interactiveUrl: string | null }>(`/api/admin/bot/runs/${run.id}/takeover`, {
        method: 'POST', body: JSON.stringify({ takeover: on }),
      })
      setComputerInfo((ci) => ci ? { ...ci, takeoverRequested: on, interactiveUrl: on ? res.interactiveUrl : null } : ci)
    } catch (e: any) { setError(e.message) } finally { setTakeoverBusy(false) }
  }

  const feedLines = (run?.events || []).slice(-200).map((e, i) => {
    if (e.type === 'status') return <div key={i} className="text-sky-400/80">◦ {e.message}</div>
    if (e.type === 'tool_call') return <div key={i} className="text-violet-300">→ {e.name}</div>
    if (e.type === 'tool_result') return <div key={i} className="text-slate-500 truncate">✓ {String(e.content || '').slice(0, 140)}</div>
    if (e.type === 'tool_output') return <div key={i} className="text-slate-600 truncate">{String((e as any).chunk || '').slice(0, 140)}</div>
    if (e.type === 'delta' || e.type === 'thinking') return null
    if (e.type === 'final') return <div key={i} className="text-emerald-300">■ {String(e.content || '').slice(0, 200)}</div>
    if (e.type === 'error') return <div key={i} className="text-rose-400">✕ {e.message}</div>
    return null
  })

  return (
    <div className="min-h-screen bg-[#0b0e14] p-6 text-slate-200">
      <div className="mx-auto max-w-6xl space-y-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link href="/admin" className="text-slate-400 hover:text-slate-200"><ArrowLeft size={18} /></Link>
            <Bot className="text-violet-400" />
            <h1 className="text-xl font-semibold">Bot computer</h1>
          </div>
          <button onClick={refresh} className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-slate-200">
            <RefreshCw size={13} /> Refresh
          </button>
        </div>
        {error && <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-300">{error}</div>}

        {/* Enqueue */}
        <div className="glass rounded-xl p-4 space-y-3">
          <div className="text-sm font-medium text-slate-300 flex items-center gap-2"><Plus size={14} /> New task</div>
          <textarea
            value={goal} onChange={(e) => setGoal(e.target.value)} rows={2}
            placeholder="Goal for the autonomous agent…"
            className="w-full rounded-lg bg-slate-900/70 px-3 py-2 text-sm outline-none ring-1 ring-slate-700/60 focus:ring-violet-500/60"
          />
          <div className="flex flex-wrap items-center gap-3 text-xs text-slate-400">
            <label className="flex items-center gap-1.5">Every
              <select value={schedule} onChange={(e) => setSchedule(e.target.value)} className="rounded bg-slate-900 px-2 py-1 ring-1 ring-slate-700/60">
                <option value="">once</option><option value="30m">30m</option><option value="1h">1h</option>
                <option value="6h">6h</option><option value="1d">1d</option>
              </select>
            </label>
            <label className="flex items-center gap-1.5">Steps
              <input type="number" min={1} max={64} value={maxSteps} onChange={(e) => setMaxSteps(Number(e.target.value))} className="w-14 rounded bg-slate-900 px-2 py-1 ring-1 ring-slate-700/60" />
            </label>
            <label className="flex items-center gap-1.5">
              <input type="checkbox" checked={computer} onChange={(e) => setComputer(e.target.checked)} />
              <MonitorPlay size={13} /> Dedicated computer
            </label>
            {computer && (
              <label className="flex items-center gap-1.5">TTL min
                <input type="number" min={5} max={240} value={ttl} onChange={(e) => setTtl(Number(e.target.value))} className="w-16 rounded bg-slate-900 px-2 py-1 ring-1 ring-slate-700/60" />
              </label>
            )}
            <button onClick={enqueue} disabled={submitting || !goal.trim()} className="ml-auto flex items-center gap-1.5 rounded-lg bg-violet-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-violet-500 disabled:opacity-40">
              {submitting ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />} Queue
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          {/* Task list */}
          <div className="glass rounded-xl p-4">
            <div className="mb-3 text-sm font-medium text-slate-300 flex items-center gap-2"><TerminalSquare size={14} /> Tasks</div>
            <div className="max-h-[480px] space-y-1.5 overflow-y-auto">
              {tasks.length === 0 && <div className="text-xs text-slate-500">No bot tasks yet.</div>}
              {tasks.map((t) => (
                <div key={t.id} onClick={() => setSelected(t)} className={`cursor-pointer rounded-lg px-3 py-2 ring-1 transition ${selected?.id === t.id ? 'bg-violet-500/10 ring-violet-500/50' : 'bg-slate-900/50 ring-slate-800 hover:ring-slate-700'}`}>
                  <div className="flex items-center justify-between gap-2">
                    <div className="truncate text-sm">{t.goal.slice(0, 90)}</div>
                    <div className="flex items-center gap-1.5">
                      {t.kind === 'scheduled' && <span className="text-[10px] text-slate-500">↻ {t.schedule}</span>}
                      <span className={`text-[11px] font-medium ${STATUS_COLOR[t.status] || 'text-slate-400'}`}>{t.status}</span>
                      {(t.status === 'queued' || t.status === 'processing') && (
                        <button onClick={(e) => { e.stopPropagation(); cancel(t.id) }} className="text-slate-500 hover:text-rose-400"><XCircle size={14} /></button>
                      )}
                    </div>
                  </div>
                  <div className="mt-0.5 text-[11px] text-slate-500">
                    attempts {t.attempts} · failures {t.failures}{t.lastErrorCode ? ` · ${t.lastErrorCode}` : ''} · {new Date(t.createdAt).toLocaleString()}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Run detail + computer */}
          <div className="space-y-4">
            <div className="glass rounded-xl p-4">
              <div className="mb-2 text-sm font-medium text-slate-300">
                {selected ? `Run ${run ? `· ${run.status}` : ''}` : 'Select a task'}
              </div>
              <div ref={feedRef} className="h-56 space-y-1 overflow-y-auto rounded-lg bg-slate-950/60 p-2 font-mono text-[11px]">
                {feedLines.length ? feedLines : <div className="text-slate-600">No events yet.</div>}
              </div>
              {run?.result && <div className="mt-2 max-h-28 overflow-y-auto rounded-lg bg-emerald-500/5 p-2 text-xs text-emerald-200/90 whitespace-pre-wrap">{run.result}</div>}
              {run?.error && <div className="mt-2 rounded-lg bg-rose-500/10 p-2 text-xs text-rose-300">{run.error}</div>}
            </div>

            {computerInfo?.viewUrl && (
              <div className="glass rounded-xl p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 text-sm font-medium text-slate-300">
                    <MonitorPlay size={14} className="text-violet-400" /> Live computer
                    <span className="text-[10px] text-slate-500">{computerInfo.sandboxId}</span>
                  </div>
                  {computerInfo.takeoverRequested ? (
                    <button onClick={() => takeover(false)} disabled={takeoverBusy} className="flex items-center gap-1.5 rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-500 disabled:opacity-40">
                      {takeoverBusy ? <Loader2 size={13} className="animate-spin" /> : <MonitorOff size={13} />} Release control
                    </button>
                  ) : (
                    <button onClick={() => takeover(true)} disabled={takeoverBusy || !computerInfo.active} className="flex items-center gap-1.5 rounded-lg bg-sky-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-sky-500 disabled:opacity-40">
                      {takeoverBusy ? <Loader2 size={13} className="animate-spin" /> : <HandMetal size={13} />} Take over
                    </button>
                  )}
                </div>
                {computerInfo.takeoverRequested && (
                  <div className="rounded-lg bg-amber-500/10 px-3 py-1.5 text-[11px] text-amber-300">
                    You are driving. The bot is paused and will resume from a fresh screenshot when you release.
                  </div>
                )}
                <div className="overflow-hidden rounded-lg ring-1 ring-slate-700/60">
                  <iframe
                    src={(computerInfo.takeoverRequested && computerInfo.interactiveUrl) || computerInfo.viewUrl}
                    className="h-[420px] w-full bg-black"
                    referrerPolicy="no-referrer"
                    title="Bot computer live view"
                  />
                </div>
                {computerInfo.minutes != null && <div className="text-[11px] text-slate-500">Session metered: {computerInfo.minutes} VM-minute(s)</div>}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
