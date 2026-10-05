'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { ArrowLeft, Bot, RefreshCw } from 'lucide-react'
import { apiFetch } from '../../lib/api'
import { useBotRunFeed } from '../../lib/botSse'
import { EnqueueForm } from '../../components/bot/EnqueueForm'
import { TaskQueueList } from '../../components/bot/TaskQueueList'
import { LiveComputerCard } from '../../components/bot/LiveComputerCard'
import { FramesStrip } from '../../components/bot/FramesStrip'
import { RunTimeline } from '../../components/bot/RunTimeline'
import { SkillManager, type BotSkill } from '../../components/bot/SkillManager'

interface BotTask {
  id: string
  kind: string
  goal: string
  status: string
  schedule?: string | null
  attempts: number
  failures: number
  cancelRequested: boolean
  lastErrorCode?: string | null
  createdAt: string
  computer?: { enabled?: boolean; ttlMinutes?: number } | null
  runs?: Array<{ id: string; status: string; error?: string | null; startedAt: string; completedAt?: string | null }>
}

interface RunView {
  id: string
  status: string
  result?: string
  error?: string
  artifacts?: Array<{ id: string; name: string; url: string; kind: string; mimeType?: string }>
  startedAt: string
}

interface ComputerInfo {
  active: boolean
  sandboxId: string
  viewUrl: string | null
  interactiveUrl: string | null
  takeoverRequested: boolean
  minutes: number | null
  startedAt: string | null
  endedAt: string | null
}

const BASE = '/api/admin/bot'

export default function AdminBotPage() {
  const [tasks, setTasks] = useState<BotTask[]>([])
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [suggestions, setSuggestions] = useState<BotSkill[]>([])
  const [skills, setSkills] = useState<BotSkill[]>([])
  const [selected, setSelected] = useState<BotTask | null>(null)
  const [run, setRun] = useState<RunView | null>(null)
  const [computerInfo, setComputerInfo] = useState<ComputerInfo | null>(null)
  const [takeoverBusy, setTakeoverBusy] = useState(false)

  const { events, connected, usingPoll } = useBotRunFeed(BASE, selected?.runs?.[0]?.id || null)

  const refresh = useCallback(async () => {
    try {
      const data = await apiFetch<{ tasks: BotTask[] }>(`${BASE}/tasks?limit=50`)
      setTasks(data.tasks || [])
      setError('')
    } catch (e: any) { setError(e.message) }
  }, [])

  useEffect(() => {
    refresh()
    const loadSkills = async () => {
      try { const s = await apiFetch<{ skills: BotSkill[] }>(`${BASE}/skills`); setSkills(s.skills || []) } catch { /* optional surface */ }
    }
    loadSkills()
    const t = setInterval(() => { if (!document.hidden) { refresh(); loadSkills() } }, 15000)
    return () => clearInterval(t)
  }, [refresh])

  // Selected task slow poll: final summary, artifacts, runs list. SSE drives
  // the live event feed; this keeps result/artifacts/terminal state fresh.
  useEffect(() => {
    if (!selected) { setRun(null); setComputerInfo(null); return }
    let stop = false
    const tick = async () => {
      try {
        const detail = await apiFetch<BotTask>(`${BASE}/tasks/${selected.id}`)
        if (stop) return
        setSelected(detail)
        const latest = detail.runs?.[0]
        if (latest) {
          const rv = await apiFetch<RunView>(`${BASE}/runs/${latest.id}`)
          if (!stop) setRun(rv)
          if (detail.computer?.enabled) {
            try {
              const ci = await apiFetch<ComputerInfo>(`${BASE}/runs/${latest.id}/computer`)
              if (!stop) setComputerInfo(ci)
            } catch { if (!stop) setComputerInfo(null) }
          } else if (!stop) setComputerInfo(null)
        }
      } catch { /* task may be gone */ }
    }
    tick()
    const t = setInterval(() => { if (!document.hidden) tick() }, 10000)
    return () => { stop = true; clearInterval(t) }
  }, [selected?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const enqueue = async (input: any) => {
    setSubmitting(true)
    try {
      const res = await apiFetch<{ task: BotTask; suggestedSkills: BotSkill[] }>(`${BASE}/tasks`, { method: 'POST', body: JSON.stringify(input) })
      setSuggestions(res.suggestedSkills || [])
      refresh()
    } catch (e: any) { setError(e.message) } finally { setSubmitting(false) }
  }

  const deleteSkill = async (ownerId: string | undefined, id: string) => {
    try {
      if (ownerId) await apiFetch(`${BASE}/skills/${ownerId}/${id}`, { method: 'DELETE' })
      else await apiFetch(`${BASE}/skills/${id}`, { method: 'DELETE' })
      const s = await apiFetch<{ skills: BotSkill[] }>(`${BASE}/skills`)
      setSkills(s.skills || [])
    } catch (e: any) { setError(e.message) }
  }

  const cancel = async (id: string) => {
    try { await apiFetch(`${BASE}/tasks/${id}/cancel`, { method: 'POST', body: '{}' }); refresh() } catch (e: any) { setError(e.message) }
  }

  const takeover = async (on: boolean) => {
    if (!run || takeoverBusy) return
    setTakeoverBusy(true)
    try {
      const res = await apiFetch<{ interactiveUrl: string | null }>(`${BASE}/runs/${run.id}/takeover`, { method: 'POST', body: JSON.stringify({ takeover: on }) })
      setComputerInfo((ci) => ci ? { ...ci, takeoverRequested: on, interactiveUrl: on ? res.interactiveUrl : null } : ci)
    } catch (e: any) { setError(e.message) } finally { setTakeoverBusy(false) }
  }

  return (
    <div className="min-h-screen bg-[#0b0e14] p-6 text-slate-200">
      <div className="mx-auto max-w-6xl space-y-5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link href="/admin" className="text-slate-400 hover:text-slate-200"><ArrowLeft size={18} /></Link>
            <Bot className="text-violet-400" />
            <h1 className="text-xl font-semibold bg-gradient-to-r from-violet-300 to-sky-300 bg-clip-text text-transparent">Bot computer</h1>
            <span className={`text-[10px] uppercase tracking-wider ${connected ? 'text-emerald-400' : usingPoll ? 'text-amber-400' : 'text-slate-500'}`}>
              {connected ? '● realtime' : usingPoll ? '● poll fallback' : '○ idle'}
            </span>
          </div>
          <button onClick={refresh} className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-slate-200"><RefreshCw size={13} /> Refresh</button>
        </div>
        {error && <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-300">{error}</div>}
        {suggestions.length > 0 && (
          <div className="rounded-lg border border-violet-500/30 bg-violet-500/10 px-3 py-2 text-sm text-violet-200">
            <div className="mb-1.5 text-[11px] uppercase tracking-wider text-violet-300/70">Skill match</div>
            <div className="flex flex-wrap items-center gap-2">
              {suggestions.map((skill) => (
                <button key={skill.id} onClick={() => { setSuggestions([]) }}
                  className="rounded-lg bg-slate-900/80 px-2.5 py-1 text-[12px] text-violet-200 ring-1 ring-violet-500/40 hover:ring-violet-400" title={skill.description}>
                  ✨ {skill.name}
                </button>
              ))}
              <span className="text-[11px] text-slate-500">taught skill matches this goal — queue again with it attached for a guided run</span>
            </div>
          </div>
        )}

        <EnqueueForm onEnqueue={enqueue} busy={submitting} computerAllowed />

        <div className="glass rounded-2xl p-4">
          <div className="mb-3 text-sm font-medium text-slate-300">Taught skills (every user)</div>
          <SkillManager skills={skills} showOwner onDelete={deleteSkill} />
        </div>

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <div className="glass rounded-2xl p-4">
            <div className="mb-3 text-sm font-medium text-slate-300">Tasks</div>
            <TaskQueueList tasks={tasks} selectedId={selected?.id} onSelect={setSelected} onCancel={cancel} />
          </div>

          <div className="space-y-4">
            {computerInfo?.viewUrl && (
              <LiveComputerCard info={computerInfo} takeover={takeover} takeoverBusy={takeoverBusy} />
            )}
            <div className="glass rounded-2xl p-4">
              <div className="mb-2 text-sm font-medium text-slate-300">
                {selected ? `Run ${run ? `· ${run.status}` : ''}` : 'Select a task'}
              </div>
              {run && <FramesStrip artifacts={run.artifacts || []} active={run.status === 'running'} />}
              <RunTimeline events={events} status={run?.status} />
              {run?.result && <div className="mt-2 max-h-28 overflow-y-auto rounded-lg bg-emerald-500/5 p-2 text-xs text-emerald-200/90 whitespace-pre-wrap">{run.result}</div>}
              {run?.error && <div className="mt-2 rounded-lg bg-rose-500/10 p-2 text-xs text-rose-300">{run.error}</div>}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}