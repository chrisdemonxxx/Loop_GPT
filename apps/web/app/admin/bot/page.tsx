'use client'

import { useEffect, useState } from 'react'
import { Bot, RefreshCw } from 'lucide-react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '../../lib/api'
import { useBotRunFeed } from '../../lib/botSse'
import { EnqueueForm } from '../../components/team-bot/EnqueueForm'
import { TaskQueueList } from '../../components/team-bot/TaskQueueList'
import { LiveComputerCard } from '../../components/team-bot/LiveComputerCard'
import { FramesStrip } from '../../components/team-bot/FramesStrip'
import { RunTimeline } from '../../components/team-bot/RunTimeline'
import { SkillManager, type BotSkill } from '../../components/team-bot/SkillManager'
import { AppPage } from '../../components/AppPage'
import { ErrorState, btnGhost } from '@loop/ui'

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
  const queryClient = useQueryClient()
  const [actionError, setActionError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [suggestions, setSuggestions] = useState<BotSkill[]>([])
  const [selected, setSelected] = useState<BotTask | null>(null)
  const [run, setRun] = useState<RunView | null>(null)
  const [computerInfo, setComputerInfo] = useState<ComputerInfo | null>(null)
  const [takeoverBusy, setTakeoverBusy] = useState(false)

  const { events, connected, usingPoll } = useBotRunFeed(BASE, selected?.runs?.[0]?.id || null)

  const tasksQuery = useQuery<{ tasks: BotTask[] }>({
    queryKey: ['admin', 'bot', 'tasks'],
    queryFn: () => apiFetch<{ tasks: BotTask[] }>(`${BASE}/tasks?limit=50`),
    enabled: typeof window !== 'undefined',
    retry: false,
    refetchInterval: 15000,
  })
  const skillsQuery = useQuery<{ skills: BotSkill[] }>({
    queryKey: ['admin', 'bot', 'skills'],
    queryFn: () => apiFetch<{ skills: BotSkill[] }>(`${BASE}/skills`),
    enabled: typeof window !== 'undefined',
    retry: false,
    refetchInterval: 15000,
  })
  const tasks = tasksQuery.data?.tasks ?? []
  const skills = skillsQuery.data?.skills ?? []
  const error = tasksQuery.isError
    ? ((tasksQuery.error as { message?: string })?.message || 'Failed to load tasks')
    : skillsQuery.isError
      ? ((skillsQuery.error as { message?: string })?.message || 'Failed to load skills')
      : actionError

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['admin', 'bot', 'tasks'] })
    void queryClient.invalidateQueries({ queryKey: ['admin', 'bot', 'skills'] })
  }

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
    } catch (e: any) { setActionError(e.message) } finally { setSubmitting(false) }
  }

  const deleteSkill = async (ownerId: string | undefined, id: string) => {
    try {
      if (ownerId) await apiFetch(`${BASE}/skills/${ownerId}/${id}`, { method: 'DELETE' })
      else await apiFetch(`${BASE}/skills/${id}`, { method: 'DELETE' })
      void queryClient.invalidateQueries({ queryKey: ['admin', 'bot', 'skills'] })
    } catch (e: any) { setActionError(e.message) }
  }

  const cancel = async (id: string) => {
    try { await apiFetch(`${BASE}/tasks/${id}/cancel`, { method: 'POST', body: '{}' }); refresh() } catch (e: any) { setActionError(e.message) }
  }

  const takeover = async (on: boolean) => {
    if (!run || takeoverBusy) return
    setTakeoverBusy(true)
    try {
      const res = await apiFetch<{ interactiveUrl: string | null }>(`${BASE}/runs/${run.id}/takeover`, { method: 'POST', body: JSON.stringify({ takeover: on }) })
      setComputerInfo((ci) => ci ? { ...ci, takeoverRequested: on, interactiveUrl: on ? res.interactiveUrl : null } : ci)
    } catch (e: any) { setActionError(e.message) } finally { setTakeoverBusy(false) }
  }

  return (
    <AppPage
      title="Bot computer"
      documentTitle="Bot computer"
      back={{ href: '/admin', label: 'Admin portal' }}
      width="wide"
      icon={<Bot size={18} className="text-[var(--accent-text)]" aria-hidden />}
      meta={(
        <span className={`text-3xs uppercase tracking-wider ${connected ? 'text-[var(--success)]' : usingPoll ? 'text-[var(--warning)]' : 'text-[var(--ink-muted)]'}`}>
          {connected ? '● realtime' : usingPoll ? '● poll fallback' : '○ idle'}
        </span>
      )}
      actions={<button type="button" onClick={refresh} className={`${btnGhost} px-2.5 py-1.5 text-ui-xs`}><RefreshCw size={13} aria-hidden /> Refresh</button>}
    >
      {error && <div className="mb-4"><ErrorState title={error} compact onDismiss={() => setActionError('')} /></div>}
      {suggestions.length > 0 && (
        <div className="mb-4 rounded-lg border border-[var(--accent-soft-border)] bg-[var(--accent-soft)] px-3 py-2 text-sm text-[var(--accent-text)]">
          <div className="mb-1.5 text-2xs uppercase tracking-wider opacity-80">Skill match</div>
          <div className="flex flex-wrap items-center gap-2">
            {suggestions.map((skill) => (
              <button key={skill.id} type="button" onClick={() => { setSuggestions([]) }}
                className="rounded-lg bg-[var(--bg-raised)] px-2.5 py-1 text-ui-xs text-[var(--accent-text)] border border-[var(--accent-soft-border)] hover:border-[var(--accent-text)]" title={skill.description}>
                ✨ {skill.name}
              </button>
            ))}
            <span className="text-2xs text-[var(--ink-muted)]">taught skill matches this goal — queue again with it attached for a guided run</span>
          </div>
        </div>
      )}

      <EnqueueForm onEnqueue={enqueue} busy={submitting} computerAllowed />

      <div className="glass rounded-2xl p-4 mt-5">
        <div className="mb-3 text-sm font-medium text-[var(--ink-secondary)]">Taught skills (every user)</div>
        <SkillManager skills={skills} showOwner onDelete={deleteSkill} />
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2 mt-5">
        <div className="glass rounded-2xl p-4">
          <div className="mb-3 text-sm font-medium text-[var(--ink-secondary)]">Tasks</div>
          <TaskQueueList tasks={tasks} selectedId={selected?.id} onSelect={setSelected} onCancel={cancel} />
        </div>

        <div className="space-y-4">
          {computerInfo?.viewUrl && (
            <LiveComputerCard info={computerInfo} takeover={takeover} takeoverBusy={takeoverBusy} />
          )}
          <div className="glass rounded-2xl p-4">
            <div className="mb-2 text-sm font-medium text-[var(--ink-secondary)]">
              {selected ? `Run ${run ? `· ${run.status}` : ''}` : 'Select a task'}
            </div>
            {run && <FramesStrip artifacts={run.artifacts || []} active={run.status === 'running'} />}
            <RunTimeline events={events} status={run?.status} />
            {run?.result && <div className="mt-2 max-h-28 overflow-y-auto rounded-lg bg-[var(--bg-tint)] border border-[var(--border-subtle)] p-2 text-ui-xs text-[var(--success)] whitespace-pre-wrap">{run.result}</div>}
            {run?.error && <div className="mt-2 rounded-lg bg-[var(--danger-soft)] border border-[var(--danger-soft-border)] p-2 text-ui-xs text-[var(--danger)]">{run.error}</div>}
          </div>
        </div>
      </div>
    </AppPage>
  )
}
