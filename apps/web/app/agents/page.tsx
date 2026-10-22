'use client'

import { Suspense, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import {
  Bot, Loader2, Sparkles, Trash2, Clock, Pause, Play, Plus, Pencil,
} from 'lucide-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ConfirmDialog } from '@loop/ui'
import {
  enqueueBotTask, listBotTasks, cancelBotTask, getBotQuota, listBotSkills, deleteBotSkill,
  listBotRoutines, createBotRoutine, setBotRoutinePaused, deleteBotRoutine,
  getBotRun, getBotTask, wakeBotComputer, BotApiError,
  type BotRoutine, type BotTask, type BotQuota, type BotSkillRef,
} from '../lib/bot'
import { getStoredUser } from '../lib/api'
import { getBotMemory } from '../lib/bot'
import { listNamedBots, listBotThreads, createBotThread, renameBotThread, deleteBotThread, type NamedBot, type BotThreadSummary } from '../lib/namedBots'
import { COMPUTER_PANE_DEFAULT, COMPUTER_PANE_KEY, COMPUTER_PANE_MIN, clampComputerPaneWidth, computerPaneMax } from './computerPane'
import RunViewer from '../components/team-bot/RunViewer'
import { AgentComputerTab } from '../components/team-bot/AgentComputerTab'
import { AgentChatPane } from '../components/team-bot/AgentChatPane'
import { BotFilesPanel } from '../components/team-bot/BotFilesPanel'
import { useTeachSession } from '../components/team-bot/useTeachSession'
import { AppPage } from '../components/AppPage'

/**
 * Loop Bot (/agents):
 *   RAIL  — New chat plus this bot's threads (rename, delete).
 *   CENTER — that thread's tasks. A message enqueues a task on the thread.
 *   RIGHT — profile card. The column width is dragged and remembered.
 *           Computer is a 16:9 frame, edge to edge in the pane.
 *
 * Accepts ?botId= to scope skills/memory/enqueue to a named bot (defaults to
 * the owner's primary) and ?thread= for the open bot conversation.
 */

function useComputerPaneWidth() {
  const preferredRef = useRef(COMPUTER_PANE_DEFAULT)
  const [width, setWidthState] = useState(COMPUTER_PANE_DEFAULT)
  const widthRef = useRef(width)
  widthRef.current = width

  useEffect(() => {
    try {
      const saved = Number(localStorage.getItem(COMPUTER_PANE_KEY))
      if (Number.isFinite(saved)) preferredRef.current = saved
    } catch { /* private mode */ }
    const sync = () => {
      const clamped = clampComputerPaneWidth(preferredRef.current, window.innerWidth)
      widthRef.current = clamped
      setWidthState(clamped)
    }
    sync()
    window.addEventListener('resize', sync)
    return () => window.removeEventListener('resize', sync)
  }, [])

  const setWidth = useCallback((next: number) => {
    const clamped = clampComputerPaneWidth(next, window.innerWidth)
    preferredRef.current = clamped
    widthRef.current = clamped
    setWidthState(clamped)
    try { localStorage.setItem(COMPUTER_PANE_KEY, String(clamped)) } catch { /* private mode */ }
    return clamped
  }, [])

  return {
    width,
    setWidth,
    widthRef,
    max: () => computerPaneMax(typeof window === 'undefined' ? 1280 : window.innerWidth),
  }
}
export default function AgentsPage() {
  return (
    <Suspense fallback={null}>
      <AgentsPageInner />
    </Suspense>
  )
}

function AgentsPageInner() {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const botIdParam = searchParams.get('botId')
  const threadParam = searchParams.get('thread')
  const queryClient = useQueryClient()
  const computerPane = useComputerPaneWidth()
  const [paneResizing, setPaneResizing] = useState(false)
  const [user, setUser] = useState<any>(null)
  const [traceTaskId, setTraceTaskId] = useState<string | null>(null)
  const [tab, setTab] = useState<'details' | 'library' | 'computer' | 'files'>('details')
  const [computerExpanded, setComputerExpanded] = useState(false)
  const [suggestedSkills, setSuggestedSkills] = useState<BotSkillRef[]>([])
  const [sendError, setSendError] = useState('')
  const [taskResults, setTaskResults] = useState<Record<string, string>>({})
  const fetchedResultsRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    const u = getStoredUser()
    if (!u) { router.replace('/login'); return }
    setUser(u)
  }, [router])

  const botsQuery = useQuery<{ bots: NamedBot[] }>({
    queryKey: ['bots', 'named'],
    queryFn: async () => {
      const { bots } = await listNamedBots()
      return { bots }
    },
    enabled: typeof window !== 'undefined' && !!user,
    retry: false,
  })

  const activeBot = useMemo(() => {
    const bots = botsQuery.data?.bots ?? []
    if (botIdParam) return bots.find((b) => b.id === botIdParam) ?? bots.find((b) => b.isPrimary) ?? bots[0] ?? null
    return bots.find((b) => b.isPrimary) ?? bots[0] ?? null
  }, [botsQuery.data?.bots, botIdParam])

  const botId = activeBot?.id ?? null
  const [openedThreadId, setOpenedThreadId] = useState<string | null>(null)
  const [threadBotId, setThreadBotId] = useState(botId)
  if (botId !== threadBotId) {
    setThreadBotId(botId)
    setOpenedThreadId(null)
  }

  const threadsQuery = useQuery<{ threads: BotThreadSummary[] }>({
    queryKey: ['bot', 'threads', botId],
    queryFn: () => listBotThreads(botId!),
    enabled: typeof window !== 'undefined' && !!user && !!botId,
    retry: false,
  })
  const threads = threadsQuery.data?.threads ?? []
  const activeThreadId = useMemo(() => {
    if (openedThreadId) return openedThreadId
    if (!threadsQuery.isSuccess) return null
    if (threadParam && threads.some((thread) => thread.id === threadParam)) return threadParam
    return threads[0]?.id ?? null
  }, [openedThreadId, threadParam, threads, threadsQuery.isSuccess])

  const selectThread = useCallback((id: string) => {
    setOpenedThreadId(id)
    const params = new URLSearchParams(searchParams.toString())
    params.set('thread', id)
    const q = params.toString()
    router.replace(q ? `${pathname}?${q}` : pathname)
  }, [pathname, router, searchParams])

  const tasksQuery = useQuery<{ tasks: BotTask[]; quota: BotQuota | null }>({
    queryKey: ['bot', 'tasks', activeThreadId],
    queryFn: async () => {
      const [t, q] = await Promise.all([
        activeThreadId
          ? listBotTasks({ limit: 100, conversationId: activeThreadId })
          : Promise.resolve({ tasks: [] as BotTask[] }),
        getBotQuota().catch(() => null),
      ])
      const tasks = activeThreadId
        ? t.tasks.filter((task) => task.conversationId === activeThreadId)
        : []
      return { tasks, quota: q }
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

  // Enrich succeeded tasks with latest run result text (for the bot bubble).
  useEffect(() => {
    if (!tasks?.length) return
    const targets = tasks
      .filter((t) => t.status === 'succeeded' && !t.result && !fetchedResultsRef.current.has(t.id))
      .slice(-8)
    if (!targets.length) return
    for (const t of targets) fetchedResultsRef.current.add(t.id)
    let cancelled = false
    void (async () => {
      const next: Record<string, string> = {}
      await Promise.all(targets.map(async (t) => {
        try {
          const detail = await getBotTask(t.id)
          const runId = detail.runs?.[0]?.id
          if (!runId) return
          const run = await getBotRun(runId)
          if (run.result) next[t.id] = run.result
        } catch { /* ignore */ }
      }))
      if (!cancelled && Object.keys(next).length) {
        setTaskResults((prev) => ({ ...prev, ...next }))
      }
    })()
    return () => { cancelled = true }
  }, [tasks])

  const displayTasks = useMemo(() => {
    if (!tasks) return null
    return tasks.map((t) => (taskResults[t.id] && !t.result ? { ...t, result: taskResults[t.id] } : t))
  }, [tasks, taskResults])

  const skillsQuery = useQuery<{ skills: BotSkillRef[] }>({
    queryKey: ['bot', 'skills', botId],
    queryFn: () => listBotSkills(botId || undefined),
    enabled: typeof window !== 'undefined' && !!user,
    retry: false,
  })
  const skills = skillsQuery.data?.skills ?? null

  const routinesQuery = useQuery<{ routines: BotRoutine[] }>({
    queryKey: ['bot', 'routines'],
    queryFn: () => listBotRoutines(),
    enabled: typeof window !== 'undefined' && !!user,
    retry: false,
    refetchInterval: 15_000,
  })
  const routineRows = routinesQuery.data?.routines ?? null

  const memoryQuery = useQuery<{ memory: string } | null>({
    queryKey: ['bot', 'memory', botId],
    queryFn: async () => {
      if (!botId) return null
      return getBotMemory(botId)
    },
    enabled: typeof window !== 'undefined' && !!user && !!botId,
    retry: false,
  })
  const botMemory = memoryQuery.data?.memory ?? ''

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['bot', 'tasks'] })
    void queryClient.invalidateQueries({ queryKey: ['bot', 'skills'] })
    void queryClient.invalidateQueries({ queryKey: ['bot', 'routines'] })
  }

  const teach = useTeachSession(refresh, botId)

  const anyActive = useMemo(() => !!tasks?.some((t) => t.status === 'queued' || t.status === 'processing'), [tasks])

  // A teach session drives the operator straight into the enlarged computer.
  useEffect(() => {
    if (teach.phase === 'waiting' || teach.phase === 'recording') {
      setTab('computer')
      setComputerExpanded(true)
    }
  }, [teach.phase])

  /** Grok parity: ONE computer surface. Wake on open; never keepalive-poll. */
  const openComputer = () => {
    setTab('computer')
    setComputerExpanded(true)
    void wakeBotComputer('default').catch(() => undefined)
  }

  const cancel = useMutation({
    mutationFn: (id: string) => cancelBotTask(id).catch(() => {}),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ['bot', 'tasks'] }) },
  })

  /** Chat is the instruction channel: a message = a one-shot task on this thread. */
  const sendInstruction = useMutation({
    mutationFn: async (text: string) => {
      let conversationId = activeThreadId
      if (!conversationId) {
        if (!botId) throw new Error('Loop Bot is still loading.')
        const thread = await createBotThread(botId)
        conversationId = thread.id
        selectThread(thread.id)
      }
      return enqueueBotTask({
        goal: text,
        maxSteps: 16,
        computer: { enabled: true, ttlMinutes: 30 },
        conversationId,
        ...(botId ? { botId } : {}),
      })
    },
    onSuccess: (res) => {
      setSendError('')
      setSuggestedSkills(res.suggestedSkills || [])
      void queryClient.invalidateQueries({ queryKey: ['bot', 'tasks'] })
      void queryClient.invalidateQueries({ queryKey: ['bot', 'threads'] })
    },
    onError: (err: unknown) => {
      if (err instanceof BotApiError) {
        if (err.status === 403) setSendError(err.message || 'Dedicated computer requires a higher plan.')
        else if (err.status === 402) setSendError(err.message || "Today's computer minutes are used up.")
        else if (err.status === 503) setSendError(err.message || 'Computer provider unavailable.')
        else setSendError(err.message || 'Could not send.')
      } else {
        setSendError((err as { message?: string })?.message || 'Could not send.')
      }
    },
  })

  if (!user) return null

  const botName = activeBot?.name || 'Loop Bot'

  const startThread = async () => {
    if (!botId) return
    try {
      const thread = await createBotThread(botId)
      selectThread(thread.id)
      void queryClient.invalidateQueries({ queryKey: ['bot', 'threads', botId] })
    } catch (err) {
      setSendError((err as { message?: string })?.message || 'Could not start a chat.')
    }
  }

  const renameThread = async (id: string, title: string) => {
    await renameBotThread(id, title)
    void queryClient.invalidateQueries({ queryKey: ['bot', 'threads', botId] })
  }

  const removeThread = async (id: string) => {
    await deleteBotThread(id)
    if (openedThreadId === id) setOpenedThreadId(null)
    void queryClient.invalidateQueries({ queryKey: ['bot', 'threads', botId] })
    void queryClient.invalidateQueries({ queryKey: ['bot', 'tasks'] })
  }

  return (
    <AppPage width="fill" documentTitle={botName}>
      {/* Status strip only while a task is running or a load error is showing. */}
      {(anyActive || loadError) && (
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
      )}

      <div className="flex-1 min-h-0 flex flex-col lg:flex-row">
        <BotThreadRail
          threads={threads}
          activeId={activeThreadId}
          pending={threadsQuery.isPending}
          error={threadsQuery.isError ? ((threadsQuery.error as { message?: string })?.message || 'Could not load chats.') : ''}
          onRetry={() => { void threadsQuery.refetch() }}
          onNew={() => { void startThread() }}
          onOpen={selectThread}
          onRename={renameThread}
          onDelete={removeThread}
        />

        <div className="flex-1 min-w-0 min-h-0 flex flex-col">
        <AgentChatPane
          tasks={displayTasks}
          sending={sendInstruction.isPending}
          sendError={sendError}
          quota={quota}
          suggestedSkills={suggestedSkills}
          onDismissSuggestions={() => setSuggestedSkills([])}
          onSend={async (text) => { await sendInstruction.mutateAsync(text) }}
          onWatch={openComputer}
          onTrace={(id) => setTraceTaskId(id)}
          onCancel={(id) => { cancel.mutate(id) }}
        />
        </div>

        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize computer pane"
          aria-valuemin={COMPUTER_PANE_MIN}
          aria-valuemax={computerPane.max()}
          aria-valuenow={computerPane.width}
          tabIndex={0}
          title="Drag to resize"
          onPointerDown={(e) => {
            const handle = e.currentTarget
            handle.setPointerCapture(e.pointerId)
            const startX = e.clientX
            const startW = computerPane.width
            const move = (ev: PointerEvent) => computerPane.setWidth(startW + (startX - ev.clientX))
            setPaneResizing(true)
            const up = () => {
              setPaneResizing(false)
              handle.removeEventListener('pointermove', move)
              handle.removeEventListener('pointerup', up)
              handle.removeEventListener('pointercancel', up)
            }
            handle.addEventListener('pointermove', move)
            handle.addEventListener('pointerup', up)
            handle.addEventListener('pointercancel', up)
          }}
          onKeyDown={(e) => {
            const step = e.shiftKey ? 24 : 8
            if (e.key === 'ArrowLeft') { e.preventDefault(); computerPane.setWidth(computerPane.widthRef.current + step) }
            else if (e.key === 'ArrowRight') { e.preventDefault(); computerPane.setWidth(computerPane.widthRef.current - step) }
            else if (e.key === 'Home') { e.preventDefault(); computerPane.setWidth(COMPUTER_PANE_MIN) }
            else if (e.key === 'End') { e.preventDefault(); computerPane.setWidth(computerPane.max()) }
          }}
          className="relative hidden lg:block shrink-0 w-1.5 cursor-col-resize touch-none focus-visible:outline focus-visible:outline-1 focus-visible:outline-[var(--accent-fill)]"
        >
          <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-[var(--border-subtle)]" />
        </div>

        {/* ── Profile panel ── */}
        <aside
          style={{ '--computer-pane': `${computerPane.width}px` } as CSSProperties}
          className={`flex flex-col min-h-0 overflow-hidden border-t lg:border-t-0 lg:border-l border-[var(--border-subtle)] bg-[var(--bg-sunken)] max-lg:max-h-[58dvh] w-full lg:w-[var(--computer-pane)] lg:shrink-0 ${paneResizing ? '' : 'lg:transition-[width] duration-200 ease-out'}`}
        >
          <div className="flex flex-col items-center pt-7 pb-4 px-4 shrink-0">
            <div className="w-16 h-16 rounded-[22px] bg-[var(--accent-soft)] border border-[var(--accent-soft-border)] flex items-center justify-center">
              <Bot size={30} className="text-[var(--accent-text)]" aria-hidden />
            </div>
            <div className="mt-3 text-ui-md font-semibold text-[var(--ink-primary)]">{botName}</div>
            <div className="text-ui-xs text-[var(--ink-muted)]">{activeBot?.label || 'Autonomous operator'}</div>
          </div>

          <div className="flex gap-1 px-4 shrink-0">
            {(['details', 'library', 'computer', 'files'] as const).map((id) => (
              <button
                key={id}
                type="button"
                onClick={() => {
                  setTab(id)
                  if (id === 'computer') void wakeBotComputer('default').catch(() => undefined)
                }}
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

          {(tab === 'details' || tab === 'library') && (
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
                {botMemory && (
                  <div>
                    <h3 className="text-2xs uppercase tracking-widest text-[var(--ink-muted)] font-medium mb-1.5">Memory</h3>
                    <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-tint)] p-2.5">
                      <p className="whitespace-pre-wrap text-2xs leading-relaxed text-[var(--ink-secondary)]">{botMemory}</p>
                      <p className="mt-1.5 text-3xs text-[var(--ink-muted)]">Kept from earlier sessions; the bot updates it as it learns.</p>
                    </div>
                  </div>
                )}
                <div>
                  <h3 className="text-2xs uppercase tracking-widest text-[var(--ink-muted)] font-medium mb-2">Routines</h3>
                  <RoutineComposer skills={skills ?? []} botId={botId} onCreated={refresh} />
                  {routineRows === null ? (
                    <div className="mt-2 text-ui-xs text-[var(--ink-muted)] flex items-center gap-2"><Loader2 size={12} className="animate-spin" aria-hidden /> Loading routines…</div>
                  ) : routineRows.length === 0 ? (
                    <p className="mt-2 text-ui-sm text-[var(--ink-muted)] leading-relaxed">
                      Nothing on a schedule yet. A routine pairs this Bot with a skill on an interval — teach a skill in the Computer, then put it on a routine.
                    </p>
                  ) : (
                    <div className="mt-2 space-y-2">
                      {routineRows.map((r) => (
                        <RoutineCard key={r.id} routine={r} onChanged={refresh} />
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
                    <span className="text-[var(--ink-secondary)]">Start recording</span> and drive the work once — the
                    recording becomes a skill here when you press Stop.
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
          </div>
          )}

          {/* Skip embedded mount while expanded — avoids duplicate status probes. */}
          {tab === 'computer' && !computerExpanded && (
            <div className="flex-1 min-h-0 flex flex-col">
              <AgentComputerTab botName={botName} session={teach} onExpand={() => setComputerExpanded(true)} />
            </div>
          )}

          {tab === 'files' && (
            <div className="flex-1 min-h-0 flex flex-col px-4 py-4">
              <BotFilesPanel onWakeComputer={() => { void wakeBotComputer('default').catch(() => undefined) }} />
            </div>
          )}
        </aside>
      </div>

      {/* Enlarged computer — full-window stream with the teach pill */}
      {computerExpanded && (
        <AgentComputerTab
          botName={botName}
          session={teach}
          expanded
          onCollapse={() => setComputerExpanded(false)}
        />
      )}

      {traceTaskId && <RunViewer taskId={traceTaskId} onClose={() => setTraceTaskId(null)} />}
    </AppPage>
  )
}

function BotThreadRail({
  threads, activeId, pending, error, onRetry, onNew, onOpen, onRename, onDelete,
}: {
  threads: BotThreadSummary[]
  activeId: string | null
  pending: boolean
  error: string
  onRetry: () => void
  onNew: () => void
  onOpen: (id: string) => void
  onRename: (id: string, title: string) => Promise<void>
  onDelete: (id: string) => Promise<void>
}) {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingTitle, setEditingTitle] = useState('')
  const [deleteId, setDeleteId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function commitEdit() {
    if (!editingId) return
    const title = editingTitle.trim()
    const id = editingId
    if (!title) { setEditingId(null); return }
    setBusy(true)
    try {
      await onRename(id, title)
      setEditingId(null)
    } catch { /* keep the editor open so the title isn't lost */ }
    finally { setBusy(false) }
  }

  return (
    <aside aria-label="Bot chats" className="flex w-full lg:w-56 shrink-0 flex-col border-b lg:border-b-0 lg:border-r border-[var(--border-subtle)] bg-[var(--bg-sunken)] max-lg:max-h-48">
      <div className="p-2 shrink-0">
        <button
          type="button"
          onClick={onNew}
          className="flex w-full items-center gap-1.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-tint)] px-2.5 py-1.5 text-ui-xs font-medium text-[var(--ink-secondary)] hover:border-[var(--accent-soft-border)] hover:text-[var(--accent-text)] transition"
        >
          <Plus size={13} aria-hidden /> New chat
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto px-2 pb-2 space-y-0.5">
        {pending && threads.length === 0 && (
          <p className="px-2 py-3 text-ui-xs text-[var(--ink-muted)] flex items-center gap-1.5"><Loader2 size={12} className="animate-spin" aria-hidden /> Loading chats…</p>
        )}
        {error && (
          <div className="px-2 py-3 text-ui-xs text-[var(--danger)]" role="alert">
            {error}
            <button type="button" onClick={onRetry} className="ml-2 text-[var(--accent-text)] hover:underline">Retry</button>
          </div>
        )}
        {!pending && !error && threads.length === 0 && (
          <p className="px-2 py-3 text-ui-xs text-[var(--ink-muted)]">No chats yet. New chat starts a fresh thread.</p>
        )}
        {threads.map((thread) => {
          const active = thread.id === activeId
          if (editingId === thread.id) {
            return (
              <input
                key={thread.id}
                value={editingTitle}
                aria-label="Chat title"
                autoFocus
                disabled={busy}
                onChange={(e) => setEditingTitle(e.target.value)}
                onBlur={() => { void commitEdit() }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { e.preventDefault(); void commitEdit() }
                  if (e.key === 'Escape') setEditingId(null)
                }}
                className="w-full rounded-lg border border-[var(--accent-soft-border)] bg-[var(--bg-base)] px-2 py-1.5 text-ui-xs text-[var(--ink-primary)] focus:outline-none"
              />
            )
          }
          return (
            <div key={thread.id} className={`group flex items-center gap-1 rounded-lg px-1.5 py-1 ${active ? 'bg-[var(--bg-hover-strong)]' : 'hover:bg-[var(--bg-hover)]'}`}>
              <button
                type="button"
                onClick={() => onOpen(thread.id)}
                className={`min-w-0 flex-1 truncate text-left text-ui-xs ${active ? 'text-[var(--ink-primary)] font-medium' : 'text-[var(--ink-secondary)]'}`}
              >
                {thread.title || 'New chat'}
              </button>
              <button
                type="button"
                aria-label={`Rename ${thread.title || 'chat'}`}
                onClick={() => { setEditingId(thread.id); setEditingTitle(thread.title || '') }}
                className="p-1 rounded text-[var(--ink-muted)] opacity-0 group-hover:opacity-100 focus:opacity-100 hover:text-[var(--ink-primary)]"
              >
                <Pencil size={11} aria-hidden />
              </button>
              <button
                type="button"
                aria-label={`Delete ${thread.title || 'chat'}`}
                onClick={() => setDeleteId(thread.id)}
                className="p-1 rounded text-[var(--ink-muted)] opacity-0 group-hover:opacity-100 focus:opacity-100 hover:text-[var(--danger)]"
              >
                <Trash2 size={11} aria-hidden />
              </button>
            </div>
          )
        })}
      </div>
      <ConfirmDialog
        open={!!deleteId}
        title="Delete this chat?"
        body="The thread and its tasks leave this list."
        confirmLabel="Delete"
        tone="danger"
        busy={busy}
        onCancel={() => { if (!busy) setDeleteId(null) }}
        onConfirm={() => {
          if (!deleteId) return
          const id = deleteId
          setBusy(true)
          void onDelete(id).then(() => setDeleteId(null)).finally(() => setBusy(false))
        }}
      />
    </aside>
  )
}

// ── Routine composer + card ──────────────────────────────────────────────────

const SCHEDULE_OPTIONS = [
  { value: '30m', label: 'every 30 min' },
  { value: '2h', label: 'every 2 hours' },
  { value: '6h', label: 'every 6 hours' },
  { value: '1d', label: 'daily' },
  { value: '7d', label: 'weekly' },
]

function RoutineComposer({ skills, botId, onCreated }: { skills: BotSkillRef[]; botId: string | null; onCreated: () => void }) {
  const [open, setOpen] = useState(false)
  const [goal, setGoal] = useState('')
  const [schedule, setSchedule] = useState('1d')
  const [skillId, setSkillId] = useState('')
  const create = useMutation({
    mutationFn: () => createBotRoutine({
      goal: goal.trim(),
      schedule,
      ...(skillId ? { skillId } : {}),
      ...(botId ? { botId } : {}),
    }),
    onSuccess: () => { setGoal(''); setSkillId(''); setOpen(false); onCreated() },
  })

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="flex items-center gap-1.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-tint)] px-2.5 py-1.5 text-ui-xs text-[var(--ink-secondary)] hover:border-[var(--accent-soft-border)] hover:text-[var(--accent-text)] transition">
        <Plus size={11} aria-hidden /> New routine
      </button>
    )
  }
  return (
    <form
      className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-tint)] p-2.5 space-y-2"
      onSubmit={(e) => { e.preventDefault(); if (goal.trim() && !create.isPending) create.mutate() }}
    >
      <textarea
        value={goal}
        onChange={(e) => setGoal(e.target.value)}
        rows={2}
        placeholder="What should the bot do on a schedule? e.g. Check the deploy status and post a summary here."
        className="w-full resize-none rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-base)] px-2.5 py-1.5 text-ui-xs text-[var(--ink-primary)] placeholder:text-[var(--ink-muted)] focus:border-[var(--accent-soft-border)] focus:outline-none"
      />
      <div className="flex items-center gap-2">
        <select value={schedule} onChange={(e) => setSchedule(e.target.value)} className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-base)] px-2 py-1 text-2xs text-[var(--ink-secondary)] focus:outline-none">
          {SCHEDULE_OPTIONS.map((opt) => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
        </select>
        <select value={skillId} onChange={(e) => setSkillId(e.target.value)} className="flex-1 min-w-0 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-base)] px-2 py-1 text-2xs text-[var(--ink-secondary)] focus:outline-none">
          <option value="">No attached skill</option>
          {skills.map((skill) => <option key={skill.id} value={skill.id}>{skill.name}</option>)}
        </select>
      </div>
      <div className="flex items-center justify-end gap-2">
        <button type="button" onClick={() => setOpen(false)} className="px-2.5 py-1 text-2xs text-[var(--ink-muted)] hover:text-[var(--ink-secondary)]">Cancel</button>
        <button type="submit" disabled={!goal.trim() || create.isPending} className="rounded-lg bg-[var(--accent-fill)] px-2.5 py-1 text-2xs font-medium text-white hover:bg-[var(--accent-fill-hover)] disabled:opacity-40 transition">
          {create.isPending ? 'Creating…' : 'Create routine'}
        </button>
      </div>
      {create.isError && <p className="text-2xs text-[var(--danger)]">{(create.error as any)?.message || 'Could not create the routine.'}</p>}
    </form>
  )
}

function RoutineCard({ routine, onChanged }: { routine: BotRoutine; onChanged: () => void }) {
  const [historyOpen, setHistoryOpen] = useState(false)
  const pause = useMutation({ mutationFn: () => setBotRoutinePaused(routine.id, !routine.paused), onSuccess: onChanged })
  const remove = useMutation({ mutationFn: () => deleteBotRoutine(routine.id), onSuccess: onChanged })
  const lastRun = routine.runs[0] ?? null

  return (
    <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-tint)] px-3 py-2.5">
      <div className="flex items-center gap-2.5">
        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${routine.paused ? 'bg-[var(--ink-muted)]' : 'bg-[var(--success)] animate-pulse'}`} aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="text-ui-sm text-[var(--ink-primary)] truncate">{routine.goal}</div>
          <div className="text-2xs text-[var(--ink-muted)] flex items-center gap-1.5 mt-0.5 flex-wrap">
            <Clock size={10} aria-hidden /> every {routine.schedule}
            {routine.skillId && <span className="rounded bg-[var(--bg-hover-strong)] px-1 py-0.5 font-mono text-3xs">{routine.skillId}</span>}
            <span>{routine.paused ? 'paused' : routine.nextRunAt ? `next ${new Date(routine.nextRunAt).toLocaleString()}` : ''}</span>
          </div>
        </div>
        <button type="button" onClick={() => pause.mutate()} disabled={pause.isPending} className="p-1.5 rounded-lg text-[var(--ink-muted)] hover:bg-[var(--bg-hover)] transition" aria-label={routine.paused ? 'Resume' : 'Pause'}>
          {routine.paused ? <Play size={12} aria-hidden /> : <Pause size={12} aria-hidden />}
        </button>
        <button type="button" onClick={() => remove.mutate()} disabled={remove.isPending} className="p-1.5 rounded-lg text-[var(--ink-muted)] hover:text-[var(--danger)] hover:bg-[var(--bg-hover)] transition" aria-label="Delete routine">
          <Trash2 size={12} aria-hidden />
        </button>
      </div>
      {lastRun && (
        <button type="button" onClick={() => setHistoryOpen((v) => !v)} className="mt-1.5 text-3xs text-[var(--ink-muted)] hover:text-[var(--ink-secondary)]">
          {historyOpen ? 'Hide' : 'Show'} history — last run {lastRun.status}{lastRun.completedAt ? ` ${new Date(lastRun.completedAt).toLocaleString()}` : ''}
        </button>
      )}
      {historyOpen && (
        <ol className="mt-2 space-y-1 border-t border-[var(--border-subtle)] pt-2">
          {routine.runs.map((run) => (
            <li key={run.id} className="flex items-center gap-2 text-3xs">
              <span className={`w-1 h-1 rounded-full ${run.status === 'succeeded' ? 'bg-[var(--success)]' : run.status === 'failed' ? 'bg-[var(--danger)]' : 'bg-[var(--accent-fill)]'}`} aria-hidden />
              <span className="text-[var(--ink-secondary)]">{run.status}</span>
              <span className="text-[var(--ink-muted)]">{run.startedAt ? new Date(run.startedAt).toLocaleString() : ''}</span>
              {run.error && <span className="truncate text-[var(--danger)]">{run.error}</span>}
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}

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
