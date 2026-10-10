'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  Bot, Loader2, Sparkles, Trash2, Clock, Monitor, Square,
} from 'lucide-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
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
import { AppPage } from '../components/AppPage'

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
  const queryClient = useQueryClient()
  const [user, setUser] = useState<any>(null)
  const [watchTaskId, setWatchTaskId] = useState<string | null>(null)
  const [tab, setTab] = useState<'details' | 'library' | 'computer'>('details')
  const [computerExpanded, setComputerExpanded] = useState(false)

  useEffect(() => {
    const u = getStoredUser()
    if (!u) { router.replace('/login'); return }
    setUser(u)
  }, [router])

  const tasksQuery = useQuery<{ tasks: BotTask[]; quota: BotQuota | null }>({
    queryKey: ['bot', 'tasks'],
    queryFn: async () => {
      const [t, q] = await Promise.all([listBotTasks({ limit: 100 }), getBotQuota().catch(() => null)])
      return { tasks: t.tasks, quota: q }
    },
    enabled: typeof window !== 'undefined' && !!user,
    retry: false,
    refetchInterval: (q) => {
      const tasks = q.state.data?.tasks
      return Array.isArray(tasks) && tasks.some((t) => t.status === 'queued' || t.status === 'processing') ? 6000 : false
    },
  })
  const tasks = tasksQuery.data?.tasks ?? null
  const quota = tasksQuery.data?.quota ?? null
  const loadError = tasksQuery.isError
    ? ((tasksQuery.error as { message?: string })?.message || 'Could not load Loop Bot tasks.')
    : ''

  const skillsQuery = useQuery<{ skills: BotSkillRef[] }>({
    queryKey: ['bot', 'skills'],
    queryFn: () => listBotSkills(),
    enabled: typeof window !== 'undefined' && !!user,
    retry: false,
  })
  const skills = skillsQuery.data?.skills ?? null

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['bot', 'tasks'] })
    void queryClient.invalidateQueries({ queryKey: ['bot', 'skills'] })
  }

  const teach = useTeachSession(refresh)

  const anyActive = useMemo(() => !!tasks?.some((t) => t.status === 'queued' || t.status === 'processing'), [tasks])

  // A teach session drives the operator straight into the enlarged computer.
  useEffect(() => {
    if (teach.phase === 'waiting' || teach.phase === 'recording') {
      setTab('computer')
      setComputerExpanded(true)
    }
  }, [teach.phase])

  const routines = useMemo(() => (tasks || []).filter((t) => t.kind === 'scheduled'), [tasks])

  const cancel = useMutation({
    mutationFn: (id: string) => cancelBotTask(id).catch(() => {}),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ['bot', 'tasks'] }) },
  })

  /** Chat is the instruction channel: a message = a one-shot task on the box. */
  const sendInstruction = useMutation({
    mutationFn: (text: string) =>
      enqueueBotTask({
        goal: text,
        maxSteps: 16,
        computer: { enabled: true, ttlMinutes: 30 },
      }),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ['bot', 'tasks'] }) },
  })

  if (!user) return null

  return (
    <AppPage width="fill" title="Loop Bot" documentTitle="Loop Bot">
      {/* Slim status strip — actions live in the computer view. */}
      <div className="flex items-center gap-3 px-4 py-2 border-b border-[var(--border-subtle)] shrink-0 min-h-[38px]">
        {anyActive && (
          <span className="flex items-center gap-1.5 text-ui-xs text-[var(--accent-text)]">
            <Loader2 size={11} className="animate-spin" aria-hidden /> working
          </span>
        )}
        {loadError && (
          <span className="ml-auto text-ui-xs text-[var(--danger)] flex items-center gap-2" role="alert">
            {loadError}
            <button type="button" onClick={() => { void tasksQuery.refetch() }} className="text-[var(--accent-text)] hover:underline">Retry</button>
          </span>
        )}
      </div>

      {/* Two panes: chat left, profile right */}
      <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-[1fr_400px]">
        {/* ── Chat pane ── */}
        <AgentChatPane
          tasks={tasks}
          sending={sendInstruction.isPending}
          onSend={async (text) => { await sendInstruction.mutateAsync(text) }}
          onWatch={(id) => setWatchTaskId(id)}
          onCancel={(id) => { cancel.mutate(id) }}
        />

        {/* ── Profile panel ── */}
        <aside className="flex flex-col min-h-0 border-t lg:border-t-0 lg:border-l border-[var(--border-subtle)] bg-[var(--bg-sunken)] max-lg:max-h-[58dvh]">
          <div className="flex flex-col items-center pt-7 pb-4 px-4 shrink-0">
            <div className="w-16 h-16 rounded-[22px] bg-[var(--accent-soft)] border border-[var(--accent-soft-border)] flex items-center justify-center">
              <Bot size={30} className="text-[var(--accent-text)]" aria-hidden />
            </div>
            <div className="mt-3 text-ui-md font-semibold text-[var(--ink-primary)]">Loop Bot</div>
            <div className="text-ui-xs text-[var(--ink-muted)]">Autonomous operator</div>
          </div>

          <div className="flex gap-1 px-4 shrink-0">
            {(['details', 'library', 'computer'] as const).map((id) => (
              <button
                key={id}
                type="button"
                onClick={() => setTab(id)}
                className={`px-3.5 py-1.5 rounded-lg text-ui-xs font-medium capitalize transition ${
                  tab === id ? 'bg-[var(--bg-hover-strong)] text-[var(--ink-primary)]' : 'text-[var(--ink-muted)] hover:text-[var(--ink-secondary)]'
                }`}
              >
                {id === 'computer' ? (
                  <span className="flex items-center gap-1.5">
                    Computer
                    {teach.phase === 'recording' && <span className="w-1.5 h-1.5 rounded-full bg-[var(--danger)] animate-pulse" aria-hidden />}
                  </span>
                ) : id}
              </button>
            ))}
          </div>

          <div className="flex-1 min-h-0 overflow-y-auto px-4 py-4">
            {tab === 'details' && (
              <div className="space-y-4">
                {quota && (
                  <p className="text-ui-xs text-[var(--ink-muted)]">
                    {quota.unlimited
                      ? 'Unlimited computer minutes (admin).'
                      : `${quota.remaining ?? 0} of ${quota.cap ?? 0} computer minutes left today.`}
                  </p>
                )}
                <div>
                  <h3 className="text-2xs uppercase tracking-widest text-[var(--ink-muted)] font-medium mb-2">Routines</h3>
                  {routines.length === 0 ? (
                    <p className="text-ui-sm text-[var(--ink-muted)] leading-relaxed">
                      Routines are recurring tasks this Bot runs on a schedule. Ask it in chat to set one up.
                    </p>
                  ) : (
                    <div className="space-y-2">
                      {routines.map((t) => (
                        <RoutineRow key={t.id} task={t} onCancel={(id) => { cancel.mutate(id) }} onWatch={() => setWatchTaskId(t.id)} />
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}

            {tab === 'library' && (
              skills === null ? (
                <div className="text-ui-xs text-[var(--ink-muted)] flex items-center gap-2"><Loader2 size={12} className="animate-spin" aria-hidden /> Loading skills…</div>
              ) : skills.length === 0 ? (
                <div className="pt-2">
                  <Sparkles size={18} className="text-[var(--ink-muted)] mb-2" aria-hidden />
                  <p className="text-ui-sm text-[var(--ink-muted)] leading-relaxed">
                    Nothing taught yet. Open the Computer, enlarge it, press{' '}
                    <span className="text-[var(--ink-secondary)]">Teach a task</span> and drive the work once — the
                    recording becomes a one-click skill here.
                  </p>
                </div>
              ) : (
                <div className="space-y-2">
                  {skills.map((skill) => (
                    <SkillCard key={skill.id} skill={skill} onDeleted={() => { void queryClient.invalidateQueries({ queryKey: ['bot', 'skills'] }) }} />
                  ))}
                </div>
              )
            )}

            {tab === 'computer' && (
              <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-tint)] overflow-hidden h-[46vh]">
                <AgentComputerTab session={teach} onExpand={() => setComputerExpanded(true)} />
              </div>
            )}
          </div>
        </aside>
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
    </AppPage>
  )
}

// ── Routine row ──────────────────────────────────────────────────────────────

function RoutineRow({ task, onCancel, onWatch }: { task: BotTask; onCancel: (id: string) => void; onWatch: () => void }) {
  const tone = BOT_STATUS_TONE[task.status]
  const active = task.status === 'queued' || task.status === 'processing'
  return (
    <div className="flex items-center gap-2.5 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-tint)] px-3 py-2.5">
      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${
        tone === 'accent' ? 'bg-[var(--accent-fill)] animate-pulse' : tone === 'green' ? 'bg-[var(--success)]' : tone === 'rose' ? 'bg-[var(--danger)]' : 'bg-[var(--ink-muted)]'
      }`} aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="text-ui-sm text-[var(--ink-primary)] truncate">{task.goal}</div>
        <div className="text-2xs text-[var(--ink-muted)] flex items-center gap-1.5 mt-0.5">
          <Clock size={10} aria-hidden /> every {task.schedule} · {BOT_STATUS_LABEL[task.status]}
        </div>
      </div>
      <button type="button" onClick={onWatch} className="p-1.5 rounded-lg text-[var(--ink-muted)] hover:bg-[var(--bg-hover)] transition" aria-label="Open trace">
        <Monitor size={13} aria-hidden />
      </button>
      {active && (
        <button type="button" onClick={() => onCancel(task.id)} className="p-1.5 rounded-lg text-[var(--ink-muted)] hover:text-[var(--danger)] hover:bg-[var(--bg-hover)] transition" aria-label="Cancel">
          <Square size={11} aria-hidden />
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
    <div className="rounded-xl bg-[var(--bg-hover)] p-3 border border-[var(--border-strong)] hover:border-[var(--border-strong)]">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-ui-sm font-medium text-[var(--ink-primary)]">{skill.name}</div>
          {skill.description && <div className="mt-0.5 truncate text-2xs text-[var(--ink-muted)]">{skill.description}</div>}
          {!!skill.triggers?.length && (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {skill.triggers.slice(0, 4).map((trigger) => (
                <span key={trigger} className="rounded bg-[var(--bg-hover-strong)] px-1.5 py-0.5 font-mono text-3xs text-[var(--ink-secondary)]">{trigger}</span>
              ))}
            </div>
          )}
        </div>
        <button type="button" onClick={() => void remove()} aria-label="Delete skill" className="shrink-0 text-[var(--ink-muted)] hover:text-[var(--danger)]"><Trash2 size={13} aria-hidden /></button>
      </div>
    </div>
  )
}
