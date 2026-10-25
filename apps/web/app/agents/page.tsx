'use client'

import { Suspense, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import {
  Bot, Loader2, Sparkles, Trash2, Clock, Pause, Play, Plus, Pencil,
} from 'lucide-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ConfirmDialog } from '@loop/ui'
import {
  enqueueBotTask, listBotTasks, cancelBotTask, getBotQuota, listBotSkills, deleteBotSkill,
  listBotRoutines, createBotRoutine, setBotRoutinePaused, deleteBotRoutine,
  getBotTask, getBotComputer, wakeBotComputer, BotApiError,
  type BotRoutine, type BotTask, type BotQuota, type BotSkillRef,
} from '../lib/bot'
import { getStoredUser } from '../lib/api'
import { getBotMemory } from '../lib/bot'
import { listNamedBots, listBotThreads, createBotThread, renameBotThread, deleteBotThread, type NamedBot, type BotThreadSummary } from '../lib/namedBots'
import { COMPUTER_PANE_DEFAULT, COMPUTER_PANE_KEY, COMPUTER_PANE_MIN, clampComputerPaneWidth, computerPaneMax } from './computerPane'
import { BOT_SECTION_TAB_CLASS } from './sectionTabs'
import {
  allowedToolsForBot, anyTaskInProgress, botMemoryQueryKey, computerForSend, computerUnavailableMessage,
  finishWatchTarget, listPanelPhase, resolveWatchTarget, routineScheduleLabel, routineSkillLabel,
  type WatchTarget,
} from './botTask'
import RunViewer from '../components/team-bot/RunViewer'
import { AgentComputerTab } from '../components/team-bot/AgentComputerTab'
import { AgentChatPane } from '../components/team-bot/AgentChatPane'
import { BotFilesPanel } from '../components/team-bot/BotFilesPanel'
import { useTeachSession } from '../components/team-bot/useTeachSession'
import { AppPage } from '../components/AppPage'
import { useToast } from '../lib/toast'

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
  const [actionError, setActionError] = useState('')
  const watchStartedRef = useRef(0)

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

  const bots = botsQuery.data?.bots ?? []
  const botsError = botsQuery.isError
    ? ((botsQuery.error as { message?: string })?.message || 'Could not load bots.')
    : ''
  const unknownBot = Boolean(botIdParam) && botsQuery.isSuccess && !bots.some((b) => b.id === botIdParam)
  const activeBot = useMemo(() => {
    if (botIdParam) return bots.find((b) => b.id === botIdParam) ?? null
    return bots.find((b) => b.isPrimary) ?? bots[0] ?? null
  }, [bots, botIdParam])

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

  const selectBot = useCallback((id: string) => {
    if (!id) return
    setOpenedThreadId(null)
    const params = new URLSearchParams(searchParams.toString())
    params.set('botId', id)
    params.delete('thread')
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
      const rows = q.state.data?.tasks
      return anyTaskInProgress(rows) ? 6000 : false
    },
  })
  const tasks = tasksQuery.data?.tasks ?? null
  const quota = tasksQuery.data?.quota ?? null
  const loadError = tasksQuery.isError
    ? ((tasksQuery.error as { message?: string })?.message || 'Could not load Loop Bot tasks.')
    : ''
  const threadsReady = !botId || threadsQuery.isSuccess || threadsQuery.isError

  const skillsQuery = useQuery<{ skills: BotSkillRef[] }>({
    queryKey: ['bot', 'skills', botId],
    queryFn: () => listBotSkills(botId || undefined),
    enabled: typeof window !== 'undefined' && !!user,
    retry: false,
  })
  const skills = skillsQuery.data?.skills ?? null
  const skillsPhase = listPanelPhase({ isPending: skillsQuery.isPending, isError: skillsQuery.isError, data: skillsQuery.data ?? null })
  const skillsError = skillsQuery.isError
    ? ((skillsQuery.error as { message?: string })?.message || 'Could not load skills.')
    : ''

  const routinesQuery = useQuery<{ routines: BotRoutine[] }>({
    queryKey: ['bot', 'routines'],
    queryFn: () => listBotRoutines(),
    enabled: typeof window !== 'undefined' && !!user,
    retry: false,
    refetchInterval: 15_000,
  })
  const routineRows = routinesQuery.data
    ? routinesQuery.data.routines.filter((routine) => routine.botId === botId)
    : null
  const routinesPhase = listPanelPhase({ isPending: routinesQuery.isPending, isError: routinesQuery.isError, data: routinesQuery.data ?? null })
  const routinesError = routinesQuery.isError
    ? ((routinesQuery.error as { message?: string })?.message || 'Could not load routines.')
    : ''
  const desktopUnavailable = computerUnavailableMessage(quota)

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
    if (botId) void queryClient.invalidateQueries({ queryKey: botMemoryQueryKey(botId) })
  }

  const teach = useTeachSession(refresh, botId, activeThreadId)
  const [attachedSkill, setAttachedSkill] = useState<BotSkillRef | null>(null)
  const [watch, setWatch] = useState<WatchTarget | null>(null)

  useEffect(() => { setAttachedSkill(null) }, [botId])

  const anyActive = useMemo(() => anyTaskInProgress(tasks), [tasks])

  useEffect(() => {
    if (!botId || !tasks || anyActive) return
    void queryClient.invalidateQueries({ queryKey: botMemoryQueryKey(botId) })
  }, [anyActive, botId, queryClient, tasks])

  // A teach session drives the operator straight into the enlarged computer.
  useEffect(() => {
    if (teach.phase === 'waiting' || teach.phase === 'recording') {
      setTab('computer')
      setComputerExpanded(true)
      setWatch(null)
    }
  }, [teach.phase])

  /** Watch keeps the task id and opens that run's computer. The Computer tab stays the persistent box. */
  const openComputer = useCallback(async (taskId: string) => {
    setTab('computer')
    setComputerExpanded(true)
    watchStartedRef.current = Date.now()
    setWatch({ taskId, runId: null, viewUrl: null, interactiveUrl: null, starting: true })
    const next = finishWatchTarget(
      await resolveWatchTarget(taskId, { getTask: getBotTask, getComputer: getBotComputer }),
      Date.now() - watchStartedRef.current,
    )
    setWatch(next)
  }, [])

  useEffect(() => {
    if (!computerExpanded || !watch?.starting) return
    const taskId = watch.taskId
    const startedAt = watchStartedRef.current
    let stop = false
    const timer = setInterval(() => {
      void resolveWatchTarget(taskId, { getTask: getBotTask, getComputer: getBotComputer }).then((next) => {
        if (!stop) setWatch(finishWatchTarget(next, Date.now() - startedAt))
      })
    }, 3000)
    return () => { stop = true; clearInterval(timer) }
  }, [computerExpanded, watch?.starting, watch?.taskId])

  const cancel = useMutation({
    mutationFn: (id: string) => cancelBotTask(id),
    onSuccess: () => {
      setActionError('')
      void queryClient.invalidateQueries({ queryKey: ['bot', 'tasks'] })
    },
    onError: (err: unknown) => {
      setActionError((err as { message?: string })?.message || 'Could not stop that task.')
    },
  })

  /** Chat is the instruction channel: a message = a one-shot task on this thread. */
  const sendInstruction = useMutation({
    mutationFn: async (text: string) => {
      if (!botId || !activeBot) {
        throw new Error(botsError || (unknownBot ? 'No bot matches this link.' : 'Select a bot before sending.'))
      }
      const allowedTools = allowedToolsForBot(activeBot.defaultTools)
      if (!allowedTools.length) throw new Error('This bot has no tools this runner can use.')
      if (botId && !threadsQuery.isSuccess && !threadsQuery.isError) {
        throw new Error('Chats are still loading.')
      }
      let conversationId = activeThreadId
      if (!conversationId) {
        if (!threadsQuery.isSuccess) throw new Error('Could not load chats.')
        const thread = await createBotThread(botId)
        conversationId = thread.id
        selectThread(thread.id)
      }
      const computer = computerForSend(activeBot.cloudComputer, quota)
      const skillId = attachedSkill?.id
      return enqueueBotTask({
        goal: text,
        maxSteps: 16,
        allowedTools,
        ...(computer ? { computer } : {}),
        conversationId,
        botId,
        ...(skillId ? { skillId } : {}),
      })
    },
    onSuccess: (res) => {
      setSendError('')
      setAttachedSkill(null)
      setSuggestedSkills(res.suggestedSkills || [])
      void queryClient.invalidateQueries({ queryKey: ['bot', 'tasks'] })
      void queryClient.invalidateQueries({ queryKey: ['bot', 'threads'] })
      if (botId) void queryClient.invalidateQueries({ queryKey: botMemoryQueryKey(botId) })
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

  const botName = activeBot?.name || ''

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
    <AppPage width="fill" documentTitle={botName || 'Bot'}>
      {(anyActive || loadError || botsError || unknownBot || actionError) && (
        <div className="flex items-center gap-3 px-4 py-2 border-b border-[var(--border-subtle)] shrink-0 min-h-[38px]">
          {anyActive && (
            <span className="flex items-center gap-1.5 text-ui-xs text-[var(--accent-text)]">
              <Loader2 size={11} className="animate-spin" aria-hidden /> working
            </span>
          )}
          {(loadError || botsError || unknownBot || actionError) && (
            <span className="ml-auto text-ui-xs text-[var(--danger)] flex items-center gap-2" role="alert">
              {actionError || botsError || (unknownBot ? 'No bot matches this link.' : loadError)}
              {(botsError || loadError) && (
                <button
                  type="button"
                  onClick={() => { if (botsError) void botsQuery.refetch(); if (loadError) void tasksQuery.refetch() }}
                  className="text-[var(--accent-text)] hover:underline"
                >
                  Retry
                </button>
              )}
            </span>
          )}
        </div>
      )}

      <div className="flex-1 min-h-0 flex flex-col lg:flex-row">
        <BotThreadRail
          threads={threads}
          activeId={activeThreadId}
          chatHref={activeThreadId ? `/chat/?conversation=${activeThreadId}` : null}
          pending={threadsQuery.isPending}
          error={threadsQuery.isError ? ((threadsQuery.error as { message?: string })?.message || 'Could not load chats.') : ''}
          onRetry={() => { void threadsQuery.refetch() }}
          onNew={() => { void startThread() }}
          onOpen={selectThread}
          onRename={renameThread}
          onDelete={removeThread}
        />

        <div className="flex-1 min-w-0 min-h-0 flex flex-col max-lg:min-h-[42dvh]">
        <AgentChatPane
          tasks={tasks}
          sending={sendInstruction.isPending}
          sendError={sendError}
          threadsReady={threadsReady}
          quota={quota}
          botName={botName}
          requiresComputer={activeBot?.cloudComputer === true}
          suggestedSkills={suggestedSkills}
          attachedSkill={attachedSkill}
          onAttachSkill={setAttachedSkill}
          onDismissSuggestions={() => setSuggestedSkills([])}
          onSend={async (text) => { await sendInstruction.mutateAsync(text) }}
          onWatch={(id) => { void openComputer(id) }}
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
          className={`flex flex-col min-h-0 overflow-hidden border-t lg:border-t-0 lg:border-l border-[var(--border-subtle)] bg-[var(--bg-sunken)] max-lg:max-h-[28dvh] w-full lg:w-[var(--computer-pane)] lg:shrink-0 ${paneResizing ? '' : 'lg:transition-[width] duration-200 ease-out'}`}
        >
          <div className="flex flex-col items-center pt-7 pb-4 px-4 shrink-0">
            <div className="w-16 h-16 rounded-[22px] bg-[var(--accent-soft)] border border-[var(--accent-soft-border)] flex items-center justify-center">
              <Bot size={30} className="text-[var(--accent-text)]" aria-hidden />
            </div>
            <div className="mt-3 text-ui-md font-semibold text-[var(--ink-primary)]">{botName || 'Bot'}</div>
            <div className="text-ui-xs text-[var(--ink-muted)]">{activeBot?.label || 'Autonomous operator'}</div>
            {bots.length > 0 && (
              <label className="mt-3 w-full">
                <span className="sr-only">Bot</span>
                <select
                  aria-label="Bot"
                  value={activeBot?.id ?? ''}
                  onChange={(e) => selectBot(e.target.value)}
                  className="w-full rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-base)] px-2 py-1.5 text-ui-xs text-[var(--ink-secondary)] focus:outline-none"
                >
                  {!activeBot && <option value="">Select a bot</option>}
                  {bots.map((bot) => <option key={bot.id} value={bot.id}>{bot.name}</option>)}
                </select>
              </label>
            )}
          </div>

          <div className="flex gap-1 px-4 shrink-0">
            {([
              ['details', 'Details'],
              ['library', 'Library'],
              ['computer', 'Computer'],
              ['files', 'Files'],
            ] as const).map(([id, label]) => (
              <button
                key={id}
                type="button"
                onClick={() => {
                  setTab(id)
                  if (id === 'computer') {
                    setWatch(null)
                    if (!desktopUnavailable) void wakeBotComputer('default').catch(() => undefined)
                  }
                }}
                className={`${BOT_SECTION_TAB_CLASS} ${
                  tab === id ? 'bg-[var(--bg-hover-strong)] text-[var(--ink-primary)]' : 'text-[var(--ink-muted)] hover:text-[var(--ink-secondary)]'
                }`}
              >
                {id === 'computer' ? (
                  <span className="flex items-center gap-1.5">
                    {label}
                    {teach.phase === 'recording' && <span className="w-1.5 h-1.5 rounded-full bg-[var(--danger)] animate-pulse" aria-hidden />}
                  </span>
                ) : label}
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
                  <RoutineComposer
                    skills={skills ?? []}
                    botId={botId}
                    conversationId={activeThreadId}
                    allowedTools={activeBot ? allowedToolsForBot(activeBot.defaultTools) : []}
                    computer={computerForSend(activeBot?.cloudComputer, quota)}
                    onCreated={refresh}
                  />
                  {routinesPhase === 'error' ? (
                    <p className="mt-2 text-ui-xs text-[var(--danger)]" role="alert">
                      {routinesError}
                      <button type="button" onClick={() => { void routinesQuery.refetch() }} className="ml-2 text-[var(--accent-text)] hover:underline">Retry</button>
                    </p>
                  ) : routinesPhase === 'loading' ? (
                    <div className="mt-2 text-ui-xs text-[var(--ink-muted)] flex items-center gap-2"><Loader2 size={12} className="animate-spin" aria-hidden /> Loading routines…</div>
                  ) : !routineRows || routineRows.length === 0 ? (
                    <p className="mt-2 text-ui-sm text-[var(--ink-muted)] leading-relaxed">
                      Nothing on a schedule yet. A routine pairs this Bot with a skill on an interval — teach a skill in the Computer, then put it on a routine.
                    </p>
                  ) : (
                    <div className="mt-2 space-y-2">
                      {routineRows.map((r) => (
                        <RoutineCard key={r.id} routine={r} skills={skills} onChanged={refresh} />
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}

            {tab === 'library' && (
              skillsPhase === 'error' ? (
                <p className="text-ui-xs text-[var(--danger)]" role="alert">
                  {skillsError}
                  <button type="button" onClick={() => { void skillsQuery.refetch() }} className="ml-2 text-[var(--accent-text)] hover:underline">Retry</button>
                </p>
              ) : skillsPhase === 'loading' ? (
                <div className="text-ui-xs text-[var(--ink-muted)] flex items-center gap-2"><Loader2 size={12} className="animate-spin" aria-hidden /> Loading skills…</div>
              ) : !skills || skills.length === 0 ? (
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
                    <SkillCard
                      key={skill.id}
                      skill={skill}
                      attached={attachedSkill?.id === skill.id}
                      onAttach={() => setAttachedSkill(attachedSkill?.id === skill.id ? null : skill)}
                      onDeleted={() => { void queryClient.invalidateQueries({ queryKey: ['bot', 'skills'] }) }}
                    />
                  ))}
                </div>
              )
            )}
          </div>
          )}

          {/* Skip embedded mount while expanded — avoids duplicate status probes. */}
          {tab === 'computer' && !computerExpanded && (
            <div className="flex-1 min-h-0 flex flex-col">
              <AgentComputerTab botName={botName || 'Bot'} session={teach} unavailableMessage={desktopUnavailable} onExpand={() => setComputerExpanded(true)} onOpenFiles={() => setTab('files')} />
            </div>
          )}

          {tab === 'files' && (
            <div className="flex-1 min-h-0 flex flex-col px-4 py-4">
              <BotFilesPanel onWakeComputer={() => { if (!desktopUnavailable) void wakeBotComputer('default').catch(() => undefined) }} />
            </div>
          )}
        </aside>
      </div>

      {/* Enlarged computer — full-window stream with the teach pill */}
      {computerExpanded && (
        <AgentComputerTab
          botName={botName || 'Bot'}
          session={teach}
          expanded
          runView={watch}
          unavailableMessage={desktopUnavailable}
          onTrace={watch ? () => setTraceTaskId(watch.taskId) : undefined}
          onOpenFiles={() => { setComputerExpanded(false); setTab('files') }}
          onCollapse={() => { setComputerExpanded(false); setWatch(null) }}
        />
      )}

      {traceTaskId && <RunViewer taskId={traceTaskId} onClose={() => setTraceTaskId(null)} />}
    </AppPage>
  )
}

function BotThreadRail({
  threads, activeId, chatHref, pending, error, onRetry, onNew, onOpen, onRename, onDelete,
}: {
  threads: BotThreadSummary[]
  activeId: string | null
  chatHref: string | null
  pending: boolean
  error: string
  onRetry: () => void
  onNew: () => void
  onOpen: (id: string) => void
  onRename: (id: string, title: string) => Promise<void>
  onDelete: (id: string) => Promise<void>
}) {
  const toast = useToast()
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
    } catch (err) {
      const message = err instanceof Error && err.message ? err.message : 'Could not rename the chat.'
      toast.push('error', message)
    }
    finally { setBusy(false) }
  }

  return (
    <aside aria-label="Bot chats" className="flex w-full lg:w-56 shrink-0 flex-col border-b lg:border-b-0 lg:border-r border-[var(--border-subtle)] bg-[var(--bg-sunken)] max-lg:max-h-28">
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
      {chatHref && (
        <div className="shrink-0 border-t border-[var(--border-subtle)] p-2">
          <Link href={chatHref} className="block rounded-lg px-2 py-1.5 text-ui-xs text-[var(--accent-text)] hover:bg-[var(--bg-hover)]">
            Open in Chat
          </Link>
        </div>
      )}
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

function RoutineComposer({
  skills, botId, conversationId, allowedTools, computer, onCreated,
}: {
  skills: BotSkillRef[]
  botId: string | null
  conversationId: string | null
  allowedTools: string[]
  computer?: { enabled: true; ttlMinutes: number }
  onCreated: () => void
}) {
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
      ...(conversationId ? { conversationId } : {}),
      allowedTools,
      ...(computer ? { computer } : {}),
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

function RoutineCard({ routine, skills, onChanged }: { routine: BotRoutine; skills: BotSkillRef[] | null; onChanged: () => void }) {
  const [historyOpen, setHistoryOpen] = useState(false)
  const [actionError, setActionError] = useState('')
  const pause = useMutation({
    mutationFn: () => setBotRoutinePaused(routine.id, !routine.paused),
    onSuccess: () => { setActionError(''); onChanged() },
    onError: (err: unknown) => setActionError((err as { message?: string })?.message || 'Could not update the routine.'),
  })
  const remove = useMutation({
    mutationFn: () => deleteBotRoutine(routine.id),
    onSuccess: () => { setActionError(''); onChanged() },
    onError: (err: unknown) => setActionError((err as { message?: string })?.message || 'Could not delete the routine.'),
  })
  const lastRun = routine.runs[0] ?? null
  const latestResult = routine.result || lastRun?.result || ''

  return (
    <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-tint)] px-3 py-2.5">
      <div className="flex items-center gap-2.5">
        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${routine.paused ? 'bg-[var(--ink-muted)]' : 'bg-[var(--success)] animate-pulse'}`} aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="text-ui-sm text-[var(--ink-primary)] truncate">{routine.goal}</div>
          <div className="text-2xs text-[var(--ink-muted)] flex items-center gap-1.5 mt-0.5 flex-wrap">
            <Clock size={10} aria-hidden /> {routineScheduleLabel(routine.schedule)}
            {routineSkillLabel(routine.skillId, skills) && (
              <span className="rounded bg-[var(--bg-hover-strong)] px-1 py-0.5 text-3xs">{routineSkillLabel(routine.skillId, skills)}</span>
            )}
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
      {latestResult && (
        <p className="mt-1.5 whitespace-pre-wrap text-ui-xs text-[var(--ink-secondary)] leading-relaxed">{latestResult}</p>
      )}
      {actionError && <p className="mt-1.5 text-2xs text-[var(--danger)]" role="alert">{actionError}</p>}
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

function SkillCard({
  skill, attached, onAttach, onDeleted,
}: {
  skill: BotSkillRef
  attached?: boolean
  onAttach?: () => void
  onDeleted: () => void
}) {
  const [deleteError, setDeleteError] = useState('')
  const remove = async () => {
    try {
      await deleteBotSkill(skill.id)
      setDeleteError('')
      onDeleted()
    } catch (err: unknown) {
      setDeleteError((err as { message?: string })?.message || 'Could not delete the skill.')
    }
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
        <div className="flex shrink-0 items-center gap-1">
          {onAttach && (
            <button type="button" onClick={onAttach} className="rounded-lg px-2 py-1 text-2xs text-[var(--accent-text)] hover:bg-[var(--bg-hover-strong)]">
              {attached ? 'Attached' : 'Attach'}
            </button>
          )}
          <button type="button" onClick={() => void remove()} aria-label="Delete skill" className="shrink-0 text-[var(--ink-muted)] hover:text-[var(--danger)]"><Trash2 size={13} aria-hidden /></button>
        </div>
      </div>
      {deleteError && <p className="mt-1.5 text-2xs text-[var(--danger)]" role="alert">{deleteError}</p>}
    </div>
  )
}
