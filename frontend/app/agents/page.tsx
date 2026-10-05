'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import {
  Bot, Plus, X, RefreshCw, Square, Monitor, ChevronDown, ChevronUp,
  Clock, Zap, AlertCircle, CheckCircle2, Loader2, ArrowLeft, Cpu, GraduationCap, Sparkles, Trash2,
} from 'lucide-react'
import {
  enqueueBotTask, listBotTasks, cancelBotTask, getBotQuota, listBotSkills, deleteBotSkill,
  BotApiError, BOT_STATUS_LABEL, BOT_STATUS_TONE,
  type BotTask, type BotQuota, type EnqueueBotInput, type BotSkillRef,
} from '../lib/bot'
import { getStoredUser } from '../lib/api'
import BotRunViewer from '../components/bot/BotRunViewer'

/** Loop Bot home (/agents): your autonomous tasks — live now, new, history.
 *  Computer sessions are a plan-gated feature with a daily VM-minute budget
 *  (free gets a 5-minute teaser); the quota strip tells the truth. */
export default function AgentsPage() {
  const router = useRouter()
  const [user, setUser] = useState<any>(null)
  const [tasks, setTasks] = useState<BotTask[] | null>(null)
  const [quota, setQuota] = useState<BotQuota | null>(null)
  const [loadError, setLoadError] = useState('')
  const [showNew, setShowNew] = useState(false)
  const [showTeach, setShowTeach] = useState(false)
  const [watchTaskId, setWatchTaskId] = useState<string | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

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

  useEffect(() => { if (user) void load() }, [user, load])

  // Poll while anything is active — the task LIST only (the run trace is SSE).
  const anyActive = useMemo(() => !!tasks?.some((t) => t.status === 'queued' || t.status === 'processing'), [tasks])
  useEffect(() => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
    if (anyActive) pollRef.current = setInterval(load, 8000)
    return () => { if (pollRef.current) clearInterval(pollRef.current) }
  }, [anyActive, load])

  const live = useMemo(() => (tasks || []).filter((t) => t.status === 'queued' || t.status === 'processing'), [tasks])
  const history = useMemo(() => (tasks || []).filter((t) => t.status !== 'queued' && t.status !== 'processing'), [tasks])

  const cancel = async (id: string) => {
    try { await cancelBotTask(id); await load() } catch { /* 409 = already settled; the next poll settles the row */ await load() }
  }

  if (!user) return null

  return (
    <div className="min-h-screen bg-[#08080a] text-slate-200">
      <div className="max-w-3xl mx-auto px-5 py-6">
        {/* Header */}
        <div className="flex items-center gap-3 mb-6">
          <Link href="/chat" className="p-1.5 rounded-lg text-slate-500 hover:text-slate-300 hover:bg-white/[0.05] transition" aria-label="Back to chat">
            <ArrowLeft size={17} />
          </Link>
          <div className="w-8 h-8 rounded-lg bg-[#c96442] flex items-center justify-center shrink-0">
            <Bot size={16} className="text-white" />
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="text-lg font-semibold text-slate-100">Loop Bot</h1>
            <p className="text-[12px] text-slate-500">Autonomous agents with their own cloud computer. Watch them work — take the wheel anytime.</p>
          </div>
          <button
            type="button"
            onClick={() => setShowTeach(true)}
            className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-[13px] font-medium text-slate-200 bg-white/[0.07] ring-1 ring-white/10 hover:bg-white/[0.12] transition"
            title="Demonstrate a task on the live computer; the bot records it and writes a reusable Skill"
          >
            🎓 Teach
          </button>
          <button
            type="button"
            onClick={() => setShowNew(true)}
            className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-[13px] font-medium text-white bg-[var(--accent)] hover:bg-[var(--accent-hover)] active:bg-[var(--accent-active)] transition shadow-[0_2px_14px_-2px_var(--accent-glow)]"
          >
            <Plus size={15} /> New Loop Bot
          </button>
        </div>

        {/* Quota strip */}
        {quota && (
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

        {/* Live now */}
        <section className="mb-7">
          <h2 className="text-[11px] uppercase tracking-widest text-slate-500 font-medium mb-2">Live now{live.length > 0 ? ` · ${live.length}` : ''}</h2>
          {live.length === 0 ? (
            <div className="rounded-xl border border-dashed border-white/[0.08] px-4 py-6 text-center">
              <Bot size={22} className="mx-auto text-slate-600 mb-2" />
              <p className="text-[13px] text-slate-400">Nothing running.</p>
              <p className="text-[12px] text-slate-600 mt-0.5">Give a Loop Bot a goal — it gets tools, time, and its own computer.</p>
            </div>
          ) : (
            <div className="space-y-2">
              {live.map((t) => (
                <TaskRow key={t.id} task={t} onCancel={cancel} onWatch={() => setWatchTaskId(t.id)} />
              ))}
            </div>
          )}
        </section>

        {/* History */}
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
      </div>

      {/* Taught skills: recorded demonstrations distilled into one-click
          automation. Teach via the Teach button below. */}
      <SkillsSection onReload={load} />

      {/* New Loop Bot form */}
      {showNew && (
        <NewBotSheet
          quota={quota}
          onClose={() => setShowNew(false)}
          onCreated={async () => { setShowNew(false); await load() }}
        />
      )}

      {/* Teach sheet: record a demonstration on the dedicated computer. */}
      {showTeach && (
        <TeachSheet
          computerAllowed={!!quota?.computerAllowed}
          onClose={() => setShowTeach(false)}
          onCreated={async () => { setShowTeach(false); await load() }}
        />
      )}

      {/* Run viewer */}
      {watchTaskId && <BotRunViewer taskId={watchTaskId} onClose={() => setWatchTaskId(null)} />}
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

// ── New Loop Bot sheet ───────────────────────────────────────────────────────

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
        role="dialog" aria-modal="true" aria-label="New Loop Bot"
        className="glass-strong rounded-t-2xl sm:rounded-2xl w-full sm:max-w-lg max-h-[88dvh] overflow-y-auto border border-white/[0.08] shadow-panel p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-[15px] font-semibold text-slate-100 flex items-center gap-2"><Bot size={16} className="text-[var(--accent-text)]" /> New Loop Bot</h2>
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


/** Taught skills section: the user's distilled demonstrations. */
function SkillsSection({ onReload }: { onReload: () => Promise<void> }) {
  const [skills, setSkills] = useState<BotSkillRef[] | null>(null)
  const [teachGoal, setTeachGoal] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    listBotSkills().then((s) => setSkills(s.skills || [])).catch(() => setSkills([]))
  }, [])

  const teach = async () => {
    if (!teachGoal.trim() || busy) return
    setBusy(true); setError('')
    try {
      await enqueueBotTask({ goal: teachGoal.trim(), kind: 'teach', maxSteps: 16, computer: { enabled: true, ttlMinutes: 15 } })
      setTeachGoal('')
      await onReload()
    } catch (err: any) {
      if (err instanceof BotApiError && err.code === 'forbidden') setError('Teaching needs a dedicated computer  Pro plan or above.')
      else setError(err?.message || 'Could not start the teach session.')
    } finally { setBusy(false) }
  }

  const remove = async (id: string) => {
    await deleteBotSkill(id).catch(() => {})
    listBotSkills().then((s) => setSkills(s.skills || [])).catch(() => {})
  }

  return (
    <section className="mb-6">
      <h2 className="text-[15px] font-semibold text-slate-100 mb-2 flex items-center gap-2"><Sparkles size={14} className="text-[var(--accent-text)]" /> Taught skills</h2>
      {error && <p className="mb-2 text-[12px] text-rose-400">{error}</p>}
      <div className="flex gap-2 mb-3">
        <input
          value={teachGoal}
          onChange={(e) => setTeachGoal(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && teach()}
          placeholder="Name a task to teach: e.g. check the SSA adult application page"
          className="flex-1 rounded-xl border border-white/10 bg-[#14141f] px-3.5 py-2 text-[13px] text-slate-200 placeholder:text-slate-600 focus:border-[var(--accent)] focus:outline-none"
        />
        <button
          type="button"
          onClick={teach}
          disabled={!teachGoal.trim() || busy}
          className="shrink-0 flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-[13px] font-medium text-white bg-[var(--accent)] hover:bg-[var(--accent-hover)] transition disabled:opacity-40"
        >
          {busy ? <Loader2 size={14} className="animate-spin" /> : <GraduationCap size={14} />} Teach
        </button>
      </div>
      {skills === null ? (
        <div className="text-[12px] text-slate-500">Loading skills</div>
      ) : skills.length === 0 ? (
        <div className="text-[12px] text-slate-500">Nothing taught yet  describe a task above, take over the live computer, demonstrate it, release. The bot records the demo and writes it into a Skill you can re-run with one click.</div>
      ) : (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {skills.map((skill) => (
            <div key={skill.id} className="rounded-xl bg-white/[0.04] p-3 ring-1 ring-white/[0.08] hover:ring-white/[0.14]">
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
                <button onClick={() => remove(skill.id)} aria-label="Delete skill" className="shrink-0 text-slate-500 hover:text-rose-400"><Trash2 size={13} /></button>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

/** Teach sheet: goal + start the recorded demonstration session. */
function TeachSheet({ computerAllowed, onClose, onCreated }: { computerAllowed: boolean; onClose: () => void; onCreated: () => Promise<void> }) {
  const [goal, setGoal] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const submit = async () => {
    if (!goal.trim() || busy) return
    setBusy(true); setError('')
    try {
      await enqueueBotTask({ goal: goal.trim(), kind: 'teach', maxSteps: 16, computer: { enabled: true, ttlMinutes: 15 } })
      onCreated()
    } catch (err: any) {
      if (err instanceof BotApiError && err.code === 'forbidden') setError('Teaching needs a dedicated computer  Pro plan or above.')
      else setError(err?.message || 'Could not start the teach session.')
      setBusy(false)
    }
  }
  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div className="w-full max-w-lg rounded-t-2xl sm:rounded-2xl border border-white/10 bg-[#0f1018] p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-[15px] font-semibold text-slate-100 flex items-center gap-2"><GraduationCap size={16} className="text-[var(--accent-text)]" /> Teach the bot</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="p-1.5 rounded-lg text-slate-400 hover:bg-white/[0.06]"><X size={16} /></button>
        </div>
        <label className="block text-[12px] text-slate-400 mb-1.5">What are you about to demonstrate?</label>
        <textarea
          value={goal} onChange={(e) => setGoal(e.target.value)} rows={2} autoFocus
          placeholder="e.g. Look up the current SSA adult application requirements"
          className="w-full rounded-xl border border-white/10 bg-[#14141f] px-3.5 py-2.5 text-[13px] text-slate-200 placeholder:text-slate-600 focus:border-[var(--accent)] focus:outline-none resize-none"
        />
        <div className="mt-3 rounded-xl bg-violet-500/10 px-3 py-2 text-[11.5px] text-violet-300/90">
          The bot opens the live computer and waits. Take over, demonstrate the task, press Release  the bot
          records the screen and distills it into a reusable Skill.
        </div>
        {!computerAllowed && <p className="mt-3 text-[12px] text-rose-400">Teaching needs a dedicated computer (Pro plan or above).</p>}
        {error && <p className="mt-3 text-[12px] text-rose-400">{error}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="px-3.5 py-2 rounded-xl text-[13px] text-slate-300 hover:bg-white/[0.06] transition">Cancel</button>
          <button type="button" onClick={submit} disabled={!goal.trim() || busy || !computerAllowed}
            className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-[13px] font-medium text-white bg-[var(--accent)] hover:bg-[var(--accent-hover)] transition disabled:opacity-40">
            {busy ? <Loader2 size={14} className="animate-spin" /> : <GraduationCap size={14} />} Start teach session
          </button>
        </div>
      </div>
    </div>
  )
}