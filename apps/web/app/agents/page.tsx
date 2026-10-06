'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import {
  Bot, ArrowLeft, Monitor, Sparkles, Loader2, Trash2, Clock, Square,
} from 'lucide-react'
import {
  enqueueBotTask, listBotTasks, cancelBotTask, getBotQuota, listBotSkills, deleteBotSkill,
  BOT_STATUS_LABEL, BOT_STATUS_TONE,
  type BotTask, type BotQuota, type BotSkillRef,
} from '../lib/bot'
import { getStoredUser } from '../lib/api'
import RunViewer from '../components/team-bot/RunViewer'
import { AgentComputerTab } from '../components/team-bot/AgentComputerTab'
import { AgentChatPane } from '../components/team-bot/AgentChatPane'
import { useTeachSession } from '../components/team-bot/useTeachSession'

/**
 * Loop Bot (/agents) — Grok Bot layout:
 *   LEFT  — the chat thread: every instruction to the bot goes through the
 *           composer ("Message Loop Bot"); the bot answers with run updates.
 *   RIGHT — the bot's profile card: avatar, name, tabs Details / Library /
 *           Computer. The Computer tab streams its persistent box small, with
 *           an expand button that enlarges it to the full window (⤢) — the
 *           expanded view carries the "⏺ Teach a task" pill, which simply
 *           starts recording the human's workflow inside the computer.
 */
export default function AgentsPage() {
  const router = useRouter()
  const [user, setUser] = useState<any>(null)
  const [tasks, setTasks] = useState<BotTask[] | null>(null)
  const [quota, setQuota] = useState<BotQuota | null>(null)
  const [loadError, setLoadError] = useState('')
  const [watchTaskId, setWatchTaskId] = useState<string | null>(null)
  const [tab, setTab] = useState<'details' | 'library' | 'computer'>('details')
  const [skills, setSkills] = useState<BotSkillRef[] | null>(null)
  const [computerExpanded, setComputerExpanded] = useState(false)
  const [sending, setSending] = useState(false)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const loadSkills = useCallback(() => {
    listBotSkills().then((s) => setSkills(s.skills || [])).catch(() => {})
  }, [])

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

  const anyActive = useMemo(() => !!tasks?.some((t) => t.status === 'queued' || t.status === 'processing'), [tasks])
  useEffect(() => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
    if (anyActive) pollRef.current = setInterval(load, 6000)
    return () => { if (pollRef.current) clearInterval(pollRef.current) }
  }, [anyActive, load])

  // A teach session drives the operator straight into the enlarged computer.
  useEffect(() => {
    if (teach.phase === 'waiting' || teach.phase === 'recording') {
      setTab('computer')
      setComputerExpanded(true)
    }
  }, [teach.phase])

  const routines = useMemo(() => (tasks || []).filter((t) => t.kind === 'scheduled'), [tasks])

  const cancel = async (id: string) => {
    try { await cancelBotTask(id); await load() } catch { await load() }
  }

  /** Chat is the instruction channel: a message = a one-shot task on the box. */
  const sendInstruction = async (text: string) => {
    if (sending) return
    setSending(true)
    try {
      await enqueueBotTask({
        goal: text,
        maxSteps: 16,
        computer: { enabled: true, ttlMinutes: 30 },
      })
      await load()
    } finally {
      setSending(false)
    }
  }

  if (!user) return null

  return (
    <div className="h-screen flex flex-col bg-[#08080a] text-slate-200 overflow-hidden">
      {/* Slim header — identity only; actions live in the computer view. */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-white/[0.06] shrink-0">
        <Link href="/chat" className="p-1.5 rounded-lg text-slate-500 hover:text-slate-300 hover:bg-white/[0.05] transition" aria-label="Back to chat">
          <ArrowLeft size={17} />
        </Link>
        <h1 className="text-[15px] font-semibold text-slate-100">Loop Bot</h1>
        {anyActive && (
          <span className="flex items-center gap-1.5 text-[11.5px] text-[var(--accent-text)]">
            <Loader2 size={11} className="animate-spin" /> working
          </span>
        )}
        {loadError && (
          <span className="ml-auto text-[12px] text-rose-300/90 flex items-center gap-2">
            {loadError}
            <button type="button" onClick={() => void load()} className="text-[#e79d7f] hover:underline">Retry</button>
          </span>
        )}
      </div>

      {/* Two panes: chat left, profile right */}
      <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-[1fr_400px]">
        {/* ── Chat pane ── */}
        <AgentChatPane
          tasks={tasks}
          sending={sending}
          onSend={sendInstruction}
          onWatch={(id) => setWatchTaskId(id)}
          onCancel={cancel}
        />

        {/* ── Profile panel ── */}
        <aside className="hidden lg:flex flex-col min-h-0 border-l border-white/[0.06] bg-[#0b0b0f]">
          <div className="flex flex-col items-center pt-7 pb-4 px-4 shrink-0">
            <div className="w-16 h-16 rounded-[22px] bg-[#c96442]/15 border border-[#c96442]/25 flex items-center justify-center">
              <Bot size={30} className="text-[#e79d7f]" />
            </div>
            <div className="mt-3 text-[17px] font-semibold text-slate-100">Loop Bot</div>
            <div className="text-[12px] text-slate-500">Autonomous operator</div>
          </div>

          <div className="flex gap-1 px-4 shrink-0">
            {(['details', 'library', 'computer'] as const).map((id) => (
              <button
                key={id}
                type="button"
                onClick={() => setTab(id)}
                className={`px-3.5 py-1.5 rounded-lg text-[12.5px] font-medium capitalize transition ${
                  tab === id ? 'bg-white/[0.09] text-slate-100' : 'text-slate-500 hover:text-slate-300'
                }`}
              >
                {id === 'computer' ? (
                  <span className="flex items-center gap-1.5">
                    Computer
                    {teach.phase === 'recording' && <span className="w-1.5 h-1.5 rounded-full bg-rose-500 animate-pulse" aria-hidden />}
                  </span>
                ) : id}
              </button>
            ))}
          </div>

          <div className="flex-1 min-h-0 overflow-y-auto px-4 py-4">
            {tab === 'details' && (
              <div className="space-y-4">
                {quota && (
                  <p className="text-[12px] text-slate-500">
                    {quota.unlimited
                      ? 'Unlimited computer minutes (admin).'
                      : `${quota.remaining ?? 0} of ${quota.cap ?? 0} computer minutes left today.`}
                  </p>
                )}
                <div>
                  <h3 className="text-[11px] uppercase tracking-widest text-slate-500 font-medium mb-2">Routines</h3>
                  {routines.length === 0 ? (
                    <p className="text-[12.5px] text-slate-500 leading-relaxed">
                      Routines are recurring tasks this Bot runs on a schedule. Ask it in chat to set one up.
                    </p>
                  ) : (
                    <div className="space-y-2">
                      {routines.map((t) => (
                        <RoutineRow key={t.id} task={t} onCancel={cancel} onWatch={() => setWatchTaskId(t.id)} />
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}

            {tab === 'library' && (
              skills === null ? (
                <div className="text-[12px] text-slate-500 flex items-center gap-2"><Loader2 size={12} className="animate-spin" /> Loading skills…</div>
              ) : skills.length === 0 ? (
                <div className="pt-2">
                  <Sparkles size={18} className="text-slate-600 mb-2" />
                  <p className="text-[12.5px] text-slate-500 leading-relaxed">
                    Nothing taught yet. Open the Computer, enlarge it, press{' '}
                    <span className="text-slate-300">Teach a task</span> and drive the work once — the
                    recording becomes a one-click skill here.
                  </p>
                </div>
              ) : (
                <div className="space-y-2">
                  {skills.map((skill) => (
                    <SkillCard key={skill.id} skill={skill} onDeleted={loadSkills} />
                  ))}
                </div>
              )
            )}

            {tab === 'computer' && (
              <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] overflow-hidden h-[46vh]">
                <AgentComputerTab session={teach} onExpand={() => setComputerExpanded(true)} />
              </div>
            )}
          </div>
        </aside>
      </div>

      {/* Mobile: computer lives behind a bottom tab bar fallback — chat stays primary */}
      <div className="lg:hidden border-t border-white/[0.06] shrink-0">
        {tab === 'computer' ? (
          <div className="h-[52vh]">
            <AgentComputerTab session={teach} onExpand={() => setComputerExpanded(true)} />
          </div>
        ) : null}
        <div className="flex gap-1 px-3 py-2">
          {(['details', 'library', 'computer'] as const).map((id) => (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              className={`px-3 py-1.5 rounded-lg text-[12px] font-medium capitalize transition ${
                tab === id ? 'bg-white/[0.09] text-slate-100' : 'text-slate-500'
              }`}
            >
              {id}
            </button>
          ))}
        </div>
      </div>

      {/* Enlarged computer — full-window stream with the teach pill */}
      {computerExpanded && (
        <AgentComputerTab
          session={teach}
          expanded
          onCollapse={() => setComputerExpanded(false)}
        />
      )}

      {watchTaskId && <RunViewer taskId={watchTaskId} onClose={() => setWatchTaskId(null)} />}
    </div>
  )
}

// ── Routine row ──────────────────────────────────────────────────────────────

function RoutineRow({ task, onCancel, onWatch }: { task: BotTask; onCancel: (id: string) => void; onWatch: () => void }) {
  const tone = BOT_STATUS_TONE[task.status]
  const active = task.status === 'queued' || task.status === 'processing'
  return (
    <div className="flex items-center gap-2.5 rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-2.5">
      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${
        tone === 'accent' ? 'bg-[var(--accent)] animate-pulse' : tone === 'green' ? 'bg-emerald-400' : tone === 'rose' ? 'bg-rose-400' : 'bg-slate-600'
      }`} aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="text-[12.5px] text-slate-200 truncate">{task.goal}</div>
        <div className="text-[11px] text-slate-500 flex items-center gap-1.5 mt-0.5">
          <Clock size={10} /> every {task.schedule} · {BOT_STATUS_LABEL[task.status]}
        </div>
      </div>
      <button type="button" onClick={onWatch} className="p-1.5 rounded-lg text-slate-400 hover:bg-white/[0.06] transition" aria-label="Open trace">
        <Monitor size={13} />
      </button>
      {active && (
        <button type="button" onClick={() => onCancel(task.id)} className="p-1.5 rounded-lg text-slate-400 hover:text-rose-300 hover:bg-white/[0.06] transition" aria-label="Cancel">
          <Square size={11} />
        </button>
      )}
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
