'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import {
  Bot, Plus, X, RefreshCw, Square, Monitor,
  Clock, Zap, AlertCircle, Loader2, ArrowLeft, Cpu, Sparkles, Trash2,
} from 'lucide-react'
import {
  enqueueBotTask, listBotTasks, cancelBotTask, getBotQuota, listBotSkills, deleteBotSkill,
  BotApiError, BOT_STATUS_LABEL, BOT_STATUS_TONE,
  type BotTask, type BotQuota, type EnqueueBotInput, type BotSkillRef,
} from '../lib/bot'
import { getStoredUser } from '../lib/api'
import RunViewer from '../components/team-bot/RunViewer'
import { TeachTaskButton } from '../components/team-bot/TeachTaskButton'
import { AgentComputerTab } from '../components/team-bot/AgentComputerTab'
import { useTeachSession } from '../components/team-bot/useTeachSession'

/**
 * Loop Bot (/agents) — Grok Bot layout: the agent as an entity (avatar + role)
 * with three tabs — Details (routines + live + history), Library (taught
 * skills), Computer (its dedicated screen, always live) — and the record-dot
 * "Teach a task" pill at the top right.
 */
export default function AgentsPage() {
  const router = useRouter()
  const [user, setUser] = useState<any>(null)
  const [tasks, setTasks] = useState<BotTask[] | null>(null)
  const [quota, setQuota] = useState<BotQuota | null>(null)
  const [loadError, setLoadError] = useState('')
  const [showNew, setShowNew] = useState(false)
  const [watchTaskId, setWatchTaskId] = useState<string | null>(null)
  const [tab, setTab] = useState<'details' | 'library' | 'computer'>('details')
  const [skills, setSkills] = useState<BotSkillRef[] | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const loadSkills = useCallback(() => {
    listBotSkills().then((s) => setSkills(s.skills || [])).catch(() => {})
  }, [])

  // The teach session (⏺ button top right + the Computer tab drive it).
  const teach = useTeachSession(loadSkills)

  useEffect(() => {
    const u = getStoredUser()
    if (!u) { router.replace('/login'); return }
    setUser(u)
  }, [router])

  const load = useCallback(async () => {
    try {
      const [t, q] = await Promise.all([listBotTasks({ limit: 100 }), getBotQuota().catch(() => null)])
      setTasks(t.tasks)
      setQuota(q)
      setLoadError('')
    } catch (err: any) {
      setLoadError(err?.message || 'Could not load Loop Bot tasks.')
    }
  }, [])

  useEffect(() => { if (user) { void load(); loadSkills() } }, [user, load, loadSkills])

  // Poll while anything is active — the task LIST only (the run trace is SSE).
  const anyActive = useMemo(() => !!tasks?.some((t) => t.status === 'queued' || t.status === 'processing'), [tasks])
  useEffect(() => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
    if (anyActive) pollRef.current = setInterval(load, 8000)
    return () => { if (pollRef.current) clearInterval(pollRef.current) }
  }, [anyActive, load])

  // A teach session in flight: jump to the Computer tab so the operator sees
  // the screen it is about to drive.
  useEffect(() => {
    if (teach.phase === 'waiting' || teach.phase === 'recording') setTab('computer')
  }, [teach.phase])

  const live = useMemo(() => (tasks || []).filter((t) => t.status === 'queued' || t.status === 'processing'), [tasks])
  const routines = useMemo(() => (tasks || []).filter((t) => t.kind === 'scheduled'), [tasks])
  const history = useMemo(() => (tasks || []).filter((t) => t.status !== 'queued' && t.status !== 'processing'), [tasks])

  const cancel = async (id: string) => {
    try { await cancelBotTask(id); await load() } catch { await load() }
  }

  if (!user) return null

  return (
    <div className="min-h-screen bg-[#08080a] text-slate-200">
      <div className="max-w-5xl mx-auto px-5 py-6">
        {/* Header: agent identity + the record-dot teach pill (top right) */}
        <div className="flex items-center gap-3 mb-5">
          <Link href="/chat" className="p-1.5 rounded-lg text-slate-500 hover:text-slate-300 hover:bg-white/[0.05] transition" aria-label="Back to chat">
            <ArrowLeft size={17} />
          </Link>
          <div className="w-10 h-10 rounded-full bg-[#c96442]/15 border border-[#c96442]/25 flex items-center justify-center shrink-0">
            <Bot size={19} className="text-[#e79d7f]" />
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="text-lg font-semibold text-slate-100">Loop Bot</h1>
            <p className="text-[12px] text-slate-500">Autonomous operator · its own cloud computer, always watchable</p>
          </div>
          <TeachTaskButton session={teach} />
          <button
            type="button"
            onClick={() => setShowNew(true)}
            className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-[13px] font-medium text-white bg-[var(--accent)] hover:bg-[var(--accent-hover)] active:bg-[var(--accent-active)] transition shadow-[0_2px_14px_-2px_var(--accent-glow)]"
          >
            <Plus size={15} /> New task
          </button>
        </div>

        {/* Tabs (Grok: Details / Library / Computer) */}
        <div className="flex gap-1 mb-5 rounded-xl bg-white/[0.04] p-1 w-fit">
          {(['details', 'library', 'computer'] as const).map((id) => (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              className={`px-4 py-1.5 rounded-lg text-[13px] font-medium capitalize transition ${
                tab === id ? 'bg-white/[0.09] text-slate-100 shadow-sm' : 'text-slate-500 hover:text-slate-300'
              }`}
            >
              {id === 'computer' ? (
                <span className="flex items-center gap-1.5">
                  <Monitor size={13} /> Computer
                  {teach.phase === 'recording' && <span className="w-1.5 h-1.5 rounded-full bg-rose-500 animate-pulse" aria-hidden />}
                </span>
              ) : id}
            </button>
          ))}
        </div>

        {/* Quota strip */}
        {quota && tab === 'details' && (
          <div className="mb-5 flex items-center gap-3 rounded-xl border border-white/[0.06] bg-white/[0.02] px-3.5 py-2.5 text-[12px]">
            <Cpu size={13} className="text-[var(--accent-text)] shrink-0" />
            {quota.unlimited ? (
              <span className="text-slate-300">Unlimited computer minutes (admin)</span>
            ) : (
              <span className="text-slate-300">
                <span className="font-medium text-slate-100 tabular-nums">{quota.remaining ?? 0}</span>
                <span className="text-slate-500"> of {quota.cap ?? 0} computer minutes left today</span>
              </span>
            )}
            {!quota.computerConfigured && (
              <span className="flex items-center gap-1 text-amber-400/90"><AlertCircle size={12} /> computer not configured on this deployment</span>
            )}
            {quota.computerAllowed && quota.cap !== null && quota.cap > 0 && (
              <div className="ml-auto h-1 w-24 rounded-full bg-white/[0.06] overflow-hidden" role="progressbar"
                aria-valuenow={Math.round(((quota.remaining ?? 0) / (quota.cap || 1)) * 100)} aria-valuemin={0} aria-valuemax={100}>
                <div className="h-full rounded-full bg-[var(--accent)] transition-all" style={{ width: `${Math.max(2, Math.round(((quota.remaining ?? 0) / (quota.cap || 1)) * 100))}%` }} />
              </div>
            )}
          </div>
        )}

        {loadError && (
          <div className="mb-5 flex items-center gap-2 rounded-xl border border-rose-400/25 bg-rose-500/[0.07] px-3.5 py-2.5 text-[13px] text-rose-200">
            <span className="flex-1">{loadError}</span>
            <button type="button" onClick={() => void load()} className="text-[#e79d7f] hover:underline shrink-0">Retry</button>
          </div>
        )}

        {/* ── Details tab ── */}
        {tab === 'details' && (
          <>
            <section className="mb-7">
              <h2 className="text-[11px] uppercase tracking-widest text-slate-500 font-medium mb-2">Live now{live.length > 0 ? ` · ${live.length}` : ''}</h2>
              {live.length === 0 ? (
                <div className="rounded-xl border border-dashed border-white/[0.08] px-4 py-6 text-center">
                  <Bot size={22} className="mx-auto text-slate-600 mb-2" />
                  <p className="text-[13px] text-slate-400">Nothing running.</p>
                  <p className="text-[12px] text-slate-600 mt-0.5">Give it a goal, or press Teach a task and show it how work is done.</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {live.map((t) => (
                    <TaskRow key={t.id} task={t} onCancel={cancel} onWatch={() => setWatchTaskId(t.id)} />
                  ))}
                </div>
              )}
            </section>

            <section className="mb-7">
              <h2 className="text-[11px] uppercase tracking-widest text-slate-500 font-medium mb-2">Routines{routines.length > 0 ? ` · ${routines.length}` : ''}</h2>
              {routines.length === 0 ? (
                <p className="text-[12px] text-slate-600 rounded-xl border border-white/[0.06] px-4 py-3">Routines are recurring tasks this Bot runs on a schedule. Give it a schedule in a new task.</p>
              ) : (
                <div className="space-y-2">
                  {routines.map((t) => (
                    <TaskRow key={t.id} task={t} onCancel={cancel} onWatch={() => setWatchTaskId(t.id)} />
                  ))}
                </div>
              )}
            </section>

            {history.length > 0 && (
              <section>
                <h2 className="text-[11px] uppercase tracking-widest text-slate-500 font-medium mb-2">History</h2>
                <div className="space-y-2">
                  {history.map((t) => (
                    <TaskRow key={t.id} task={t} onCancel={cancel} onWatch={() => setWatchTaskId(t.id)} />
                  ))}
                </div>
              </section>
            )}
          </>
        )}

        {/* ── Library tab ── */}
        {tab === 'library' && (
          <section>
            <h2 className="text-[15px] font-semibold text-slate-100 mb-2 flex items-center gap-2"><Sparkles size={14} className="text-[var(--accent-text)]" /> Taught skills</h2>
            {skills === null ? (
              <div className="text-[12px] text-slate-500 flex items-center gap-2"><Loader2 size={12} className="animate-spin" /> Loading skills…</div>
            ) : skills.length === 0 ? (
              <div className="rounded-xl border border-dashed border-white/[0.08] px-4 py-6 text-center">
                <Sparkles size={20} className="mx-auto text-slate-600 mb-2" />
                <p className="text-[13px] text-slate-400">Nothing taught yet.</p>
                <p className="text-[12px] text-slate-600 mt-0.5 max-w-md mx-auto">
                  Press <span className="text-slate-300">Teach a task</span> at the top right, drive the bot&apos;s computer through the work once, stop — it converts the recording into a skill it can execute on its own.
                </p>
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {skills.map((skill) => (
                  <SkillCard key={skill.id} skill={skill} onDeleted={loadSkills} />
                ))}
              </div>
            )}
          </section>
        )}

        {/* ── Computer tab ── */}
        {tab === 'computer' && (
          <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] overflow-hidden h-[62vh]">
            <AgentComputerTab session={teach} />
          </div>
        )}
      </div>

      {/* New task form */}
      {showNew && (
        <NewBotSheet
          quota={quota}
          onClose={() => setShowNew(false)}
          onCreated={async () => { setShowNew(false); await load() }}
        />
      )}

      {/* Run viewer (watch/trace a task) */}
      {watchTaskId && <RunViewer taskId={watchTaskId} onClose={() => setWatchTaskId(null)} />}
    </div>
  )
}

// ── Task row ─────────────────────────────────────────────────────────────────

function TaskRow({ task, onCancel, onWatch }: { task: BotTask; onCancel: (id: string) => void; onWatch: () => void }) {
  const tone = BOT_STATUS_TONE[task.status]
  const active = task.status === 'queued' || task.status === 'processing'
  return (
    <div className="flex items-center gap-3 rounded-xl border border-white/[0.06] bg-white/[0.02] px-3.5 py-3">
      <span className={`w-2 h-2 rounded-full shrink-0 ${
        tone === 'accent' ? 'bg-[var(--accent)] animate-pulse' : tone === 'green' ? 'bg-emerald-400' : tone === 'rose' ? 'bg-rose-400' : 'bg-slate-600'
      }`} aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="text-[13px] text-slate-200 truncate">{task.goal}</div>
        <div className="text-[11px] text-slate-500 flex items-center gap-2 mt-0.5">
          <span>{BOT_STATUS_LABEL[task.status]}</span>
          {task.kind === 'scheduled' && <span className="flex items-center gap-0.5"><Clock size={10} /> every {task.schedule}</span>}
          {task.kind === 'teach' && <span className="text-violet-300/90">teach session</span>}
          {task.lastErrorCode && <span className="text-rose-400/90">{task.lastErrorCode.replace(/^BOT_/, '').replace(/_/g, ' ').toLowerCase()}</span>}
          {task.attempts > 1 && <span>attempt {task.attempts}</span>}
        </div>
      </div>
      <div className="flex items-center gap-1.5 shrink-0">
        <button
          type="button"
          onClick={onWatch}
          className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[12px] bg-white/[0.04] text-slate-300 hover:bg-white/[0.08] transition"
        >
          <Monitor size={12} /> {active ? 'Watch' : 'Trace'}
        </button>
        {active && (
          <button
            type="button"
            onClick={() => onCancel(task.id)}
            className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[12px] text-slate-400 hover:text-rose-300 hover:bg-white/[0.05] transition"
          >
            <Square size={10} /> Cancel
          </button>
        )}
      </div>
    </div>
  )
}

// ── Skill card ────────────────────────────────────────────────────────────────

function SkillCard({ skill, onDeleted }: { skill: BotSkillRef; onDeleted: () => void }) {
  const remove = async () => {
    await deleteBotSkill(skill.id).catch(() => {})
    onDeleted()
  }
  return (
    <div className="rounded-xl bg-white/[0.04] p-3 ring-1 ring-white/[0.08] hover:ring-white/[0.14]">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-[13px] font-medium text-slate-200">{skill.name}</div>
          {skill.description && <div className="mt-0.5 truncate text-[11px] text-slate-500">{skill.description}</div>}
          {!!skill.triggers?.length && (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {skill.triggers.slice(0, 4).map((trigger) => (
                <span key={trigger} className="rounded bg-white/[0.07] px-1.5 py-0.5 font-mono text-[10px] text-slate-400">{trigger}</span>
              ))}
            </div>
          )}
        </div>
        <button onClick={remove} aria-label="Delete skill" className="shrink-0 text-slate-500 hover:text-rose-400"><Trash2 size={13} /></button>
      </div>
    </div>
  )
}

// ── New task sheet ───────────────────────────────────────────────────────────

const TOOL_CHOICES = ['web_search', 'web_fetch', 'execute_code', 'create_document', 'calculator', 'get_current_time', 'remember', 'search_knowledge'] as const

function NewBotSheet({ quota, onClose, onCreated }: { quota: BotQuota | null; onClose: () => void; onCreated: () => void }) {
  const [goal, setGoal] = useState('')
  const [schedule, setSchedule] = useState('')
  const [tools, setTools] = useState<string[]>([...TOOL_CHOICES])
  const [maxSteps, setMaxSteps] = useState(16)
  const [withComputer, setWithComputer] = useState(false)
  const [ttl, setTtl] = useState(15)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const computerLocked = quota ? !quota.computerAllowed : false
  const computerCap = quota?.remaining ?? null
  const effectiveTtl = computerCap !== null ? Math.min(ttl, computerCap) : ttl

  const submit = async () => {
    if (!goal.trim() || busy) return
    setBusy(true); setError('')
    const input: EnqueueBotInput = {
      goal: goal.trim(),
      maxSteps,
      ...(schedule ? { kind: 'scheduled', schedule } : {}),
      allowedTools: tools,
      ...(withComputer && !computerLocked ? { computer: { enabled: true, ttlMinutes: effectiveTtl } } : {}),
    }
    try {
      await enqueueBotTask(input)
      onCreated()
    } catch (err: any) {
      if (err instanceof BotApiError && err.code === 'quota') setError("Today's computer budget is used up — it resets with your daily credits.")
      else if (err instanceof BotApiError && err.code === 'forbidden') setError('Computer sessions need a higher plan — but the bot itself still runs. Uncheck the computer and go.')
      else setError(err?.message || 'Could not create the Loop Bot.')
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div
        role="dialog" aria-modal="true" aria-label="New Loop Bot task"
        className="glass-strong rounded-t-2xl sm:rounded-2xl w-full sm:max-w-lg max-h-[88dvh] overflow-y-auto border border-white/[0.08] shadow-panel p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-[15px] font-semibold text-slate-100 flex items-center gap-2"><Bot size={16} className="text-[var(--accent-text)]" /> New task</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="p-1.5 rounded-lg text-slate-400 hover:bg-white/[0.06]"><X size={16} /></button>
        </div>

        <label className="block text-[12px] text-slate-400 mb-1.5">Goal</label>
        <textarea
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          rows={3}
          autoFocus
          placeholder="e.g. Every morning, check the releases page of our three key dependencies and post a summary with links."
          className="w-full rounded-xl border border-white/10 bg-[#14141f] px-3.5 py-2.5 text-[13px] text-slate-200 placeholder:text-slate-600 focus:border-[var(--accent)] focus:outline-none resize-none"
        />

        <div className="mt-4 grid grid-cols-2 gap-3">
          <div>
            <label className="block text-[12px] text-slate-400 mb-1.5">Schedule</label>
            <select
              value={schedule}
              onChange={(e) => setSchedule(e.target.value)}
              className="w-full rounded-xl border border-white/10 bg-[#14141f] px-3 py-2.5 text-[13px] text-slate-200 focus:border-[var(--accent)] focus:outline-none"
            >
              <option value="">One-shot</option>
              <option value="30m">Every 30 min</option>
              <option value="1h">Hourly</option>
              <option value="6h">Every 6 hours</option>
              <option value="1d">Daily</option>
              <option value="7d">Weekly</option>
            </select>
          </div>
          <div>
            <label className="block text-[12px] text-slate-400 mb-1.5">Max steps · {maxSteps}</label>
            <input
              type="range" min={4} max={64} value={maxSteps}
              onChange={(e) => setMaxSteps(Number(e.target.value))}
              className="w-full mt-3 accent-[#c96442]"
              aria-label="Max steps"
            />
          </div>
        </div>

        <label className="block text-[12px] text-slate-400 mt-4 mb-1.5">Tools</label>
        <div className="flex flex-wrap gap-1.5">
          {TOOL_CHOICES.map((t) => {
            const on = tools.includes(t)
            return (
              <button
                key={t}
                type="button"
                aria-pressed={on}
                onClick={() => setTools((cur) => on ? cur.filter((x) => x !== t) : [...cur, t])}
                className={`px-2.5 py-1 rounded-lg text-[11.5px] border transition ${
                  on ? 'border-[var(--accent-soft-border)] text-[var(--accent-text)] bg-[var(--accent-soft)]' : 'border-white/[0.08] text-slate-500 hover:text-slate-300'
                }`}
              >
                {t}
              </button>
            )
          })}
        </div>

        {/* Computer toggle — plan-gated with the honest reason inline */}
        <div className={`mt-4 rounded-xl border p-3.5 ${computerLocked ? 'border-white/[0.06] opacity-80' : 'border-white/[0.06]'}`}>
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-[13px] text-slate-200 flex items-center gap-1.5"><Monitor size={13} className="text-[var(--accent-text)]" /> Dedicated cloud computer</div>
              <div className="text-[11.5px] text-slate-500 mt-0.5">
                {computerLocked
                  ? 'Your plan has no computer budget today. Pro gets 30 min/day.'
                  : `Watch it work live and take over anytime. ${computerCap !== null ? `${computerCap} min left today.` : ''}`}
              </div>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={withComputer}
              disabled={computerLocked}
              onClick={() => setWithComputer((v) => !v)}
              className={`shrink-0 w-11 h-6 rounded-full transition disabled:opacity-40 ${withComputer ? 'bg-[var(--accent)]' : 'bg-white/10 hover:bg-white/15'}`}
            >
              <span className={`block w-5 h-5 bg-white rounded-full transition-transform ${withComputer ? 'translate-x-5' : 'translate-x-0.5'}`} />
            </button>
          </div>
          {withComputer && !computerLocked && (
            <div className="mt-3">
              <label className="block text-[11.5px] text-slate-500 mb-1">Time budget · {effectiveTtl} min</label>
              <input
                type="range" min={5} max={Math.max(5, computerCap ?? 60)} value={effectiveTtl}
                onChange={(e) => setTtl(Number(e.target.value))}
                className="w-full accent-[#c96442]"
                aria-label="Computer time budget in minutes"
              />
            </div>
          )}
        </div>

        {error && <p className="mt-3 text-[12px] text-rose-400">{error}</p>}

        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="px-3.5 py-2 rounded-xl text-[13px] text-slate-300 hover:bg-white/[0.06] transition">Cancel</button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={!goal.trim() || busy || tools.length === 0}
            className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-[13px] font-medium text-white bg-[var(--accent)] hover:bg-[var(--accent-hover)] active:bg-[var(--accent-active)] transition disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Zap size={14} />}
            {schedule ? 'Schedule it' : 'Run it'}
          </button>
        </div>
      </div>
    </div>
  )
}