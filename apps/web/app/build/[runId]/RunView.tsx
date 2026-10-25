'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import {
  AlertTriangle, ArrowLeft, ArrowRight, CheckCircle2, ChevronDown, ChevronRight, Crosshair, Database, ExternalLink, FileCode2,
  FileText, FlaskConical, Loader2, Monitor, Play, Rocket, RotateCw, Send, Shield, ShieldCheck, Smartphone, Sparkles, Square, Tablet, Terminal, X,
} from 'lucide-react'
import { Badge, EmptyState, LoadingState, SectionHeader, StatusDot, btnGhost, btnOutline, btnPrimary, panelCls, textareaCls } from '@loop/ui'
import {
  ApiError,
  emptyRunUiState,
  extractCost,
  extractDag,
  extractGates,
  isCompletedNode,
  isServiceMissing,
  isUnreachable,
  orderedDagNodes,
  pickPreviewFile,
  reduceRunEvent,
  applyVisualEdit,
  getPreviewMeta,
  listDeployments,
  resolvePreviewUrl,
  getProjectDatabase,
  getProjectDatabaseTable,
  reportConsoleError,
  republishProject,
  runTitle,
  toUserFacingError,
  unpublishProject,
  type PreviewMeta,
  type Activity,
  type ApprovalGate,
  type CheckpointView,
  type EffortTier,
  type FileChange,
  type RunMode,
  type RunSummary,
  type StreamEvent,
  type TaskNodeView,
} from '@loop/loopit-client'
import { useToast } from '../../lib/toast'
import { AppPage } from '../../components/AppPage'
import { BuildSessionRail } from '../SessionRail'
import { CheckpointDialog, type CheckpointAction } from '../confirm'
import {
  useBuildRun, useCancelRun, useCheckpointAction, useGateDecision,
  useGatesEnabled, usePreviewUrl, useRunStream, useSendRunMessage, useStartBuild, useTerminalAccess,
} from '../hooks'
import { ErrorNotice } from '../shell'
import { formatWhen, gateTitle, isLiveStatus, statusLabel, statusStepper, statusTone } from '../status'
import { runConversationId } from '../runLink'
import { FileChangeChips } from '../DiffView'
import { ModeSwitch } from '../ModeSwitch'
import { CostTransparencyBar, EffortEstimateNotice, EffortSwitch } from '../EffortSwitch'
import { MobileBuildSplit } from '../MobileBuildSplit'
import { NotificationsBell } from '../NotificationsBell'
import {
  BrowserTestsPanel,
  EditingElementChip,
  SecurityPanel,
  type InspectTarget,
} from '../Phase2Panels'
import { CodeEditorDrawer } from '../CodeEditorDrawer'
import { TerminalPane, type TerminalEntry } from '../TerminalPane'
import {
  normalizePreviewRoute,
  previewIframeKey,
  previewMaxWidth,
  previewRouteOptions,
  shouldClearInspectAfterEdit,
  type PreviewDevice,
} from '../previewDevices'

/** Scripts + forms/popups for HMR/Vite apps. allow-same-origin omitted so the preview cannot read the app. */
const PREVIEW_SANDBOX = 'allow-scripts allow-forms allow-popups'

const BACK = { href: '/build', label: 'All builds' }
const PROJECTS = { href: '/build/projects', label: 'Build projects' }

/** One bubble in the run's chat pane. `pending` marks an optimistic user
 *  bubble waiting for the stream's journaled echo to confirm it landed. */
type ChatMessage = { id: string; role: 'user' | 'assistant' | 'system'; text: string; at: string; pending?: boolean }

type ConsoleEntry = { id: string; level: string; text: string; at: string; source: 'preview' | 'sandbox' }

export default function RunView({ runId: runIdProp }: { runId?: string }) {
  const params = useParams()
  const router = useRouter()
  const raw = runIdProp ?? params?.runId
  const runId = typeof raw === 'string' ? raw : ''
  const query = useBuildRun(runId)
  const toast = useToast()
  const [ui, setUi] = useState(emptyRunUiState)
  const [showCompleted, setShowCompleted] = useState(false)
  const [action, setAction] = useState<CheckpointAction | null>(null)
  const [deployUrl, setDeployUrl] = useState<string | null>(null)
  const [deploymentId, setDeploymentId] = useState<string | null>(null)
  const [deployStatus, setDeployStatus] = useState<'live' | 'unpublished' | null>(null)
  const [deployBusy, setDeployBusy] = useState(false)
  const [previewPath, setPreviewPath] = useState<string | null>(null)
  const [codePath, setCodePath] = useState<string | null>(null)
  const [diffChange, setDiffChange] = useState<FileChange | null>(null)
  const [compareCheckpointId, setCompareCheckpointId] = useState<string | null>(null)
  const [previewEpoch, setPreviewEpoch] = useState(0)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [streamingText, setStreamingText] = useState<string | null>(null)
  const [terminalHistory, setTerminalHistory] = useState<TerminalEntry[]>([])
  const [consoleEntries, setConsoleEntries] = useState<ConsoleEntry[]>([])
  const [terminalOpen, setTerminalOpen] = useState(false)
  const [continueMode, setContinueMode] = useState<RunMode>('build')
  const [continueTier, setContinueTier] = useState<EffortTier>('standard')
  const [inspectMode, setInspectMode] = useState(false)
  const [inspectTarget, setInspectTarget] = useState<InspectTarget | null>(null)
  const composerRef = useRef<HTMLTextAreaElement>(null)
  const previewIframeRef = useRef<HTMLIFrameElement>(null)
  const seenSeqRef = useRef<Set<number>>(new Set())
  const reloadTimer = useRef<number | null>(null)
  const hmrModeRef = useRef(false)

  const sendMessage = useSendRunMessage(runId)
  const cancel = useCancelRun(runId)
  const terminalAllowed = useTerminalAccess()

  useEffect(() => {
    const detail = query.data
    if (!detail) return
    setUi((prev) => ({
      ...prev,
      run: detail,
      dag: extractDag(detail) ?? prev.dag,
      gates: extractGates(detail).length ? extractGates(detail) : prev.gates,
      checkpoints: detail.checkpoints ?? prev.checkpoints,
      cost: extractCost(detail),
    }))
    setPreviewPath((current) => current ?? pickPreviewFile(detail.files) ?? null)
  }, [query.data])

  /** Remount the static preview after file writes. Skipped when HMR is active
   *  so Vite can update the iframe in place (Phase 1.4). */
  const pokePreviewReload = useCallback(() => {
    if (hmrModeRef.current) return
    if (reloadTimer.current) window.clearTimeout(reloadTimer.current)
    reloadTimer.current = window.setTimeout(() => setPreviewEpoch((n) => n + 1), 1500)
  }, [])

  const onStream = useCallback((event: StreamEvent) => {
    // Journal replay (reload) and reconnects re-send events with their durable
    // sequence number; applying one twice would double a chat bubble.
    const seq = (event as { _seq?: unknown })._seq
    if (typeof seq === 'number') {
      if (seenSeqRef.current.has(seq)) return
      seenSeqRef.current.add(seq)
    }
    setUi((prev) => reduceRunEvent(prev, event))
    if (event.kind === 'chat_chunk') {
      const chunk = event.text
      setStreamingText((prev) => (prev ?? '') + chunk)
    }
    if (event.kind === 'chat') {
      const chat = event
      if (chat.role === 'assistant') setStreamingText(null)
      setMessages((prev) => {
        if (chat.role === 'user') {
          // The steering echo resolves the optimistic bubble posted on send.
          const pending = prev.findIndex((m) => m.pending && m.role === 'user' && m.text === chat.text)
          if (pending >= 0) {
            const next = [...prev]
            next[pending] = { ...next[pending], pending: false }
            return next
          }
        }
        return [...prev, { id: `chat-${seq ?? prev.length}-${chat.role}`, role: chat.role, text: chat.text, at: new Date().toISOString() }]
      })
    }
    if (event.kind === 'log') {
      setConsoleEntries((prev) => [
        ...prev.slice(-199),
        {
          id: `log-${seq ?? prev.length}`,
          level: event.stream === 'stderr' ? 'error' : 'log',
          text: event.text,
          at: new Date().toISOString(),
          source: 'sandbox',
        },
      ])
    }
    if (event.kind === 'run') {
      const next = pickPreviewFile(event.files)
      if (next) setPreviewPath((current) => current ?? next)
      pokePreviewReload()
    }
    if (event.kind === 'audit' && event.type === 'tool.called' && event.outcome === 'success') {
      pokePreviewReload()
    }
  }, [pokePreviewReload])

  const status = ui.run?.status ?? query.data?.status
  const live = isLiveStatus(status)
  // Always subscribed: for a live run the stream carries new events; for a
  // finished run the engine replays the durable journal and closes, so the
  // PROGRESS panel shows the full history instead of "Nothing to report yet".
  // While live, reconnect after a clean close (proxy idle cut) with ?after=.
  useRunStream(runId, true, onStream, { live: !!live })

  const projectId = ui.run?.project_id ?? query.data?.project_id ?? null

  useEffect(() => {
    if (!projectId) return
    let cancelled = false
    void listDeployments(projectId).then((rows) => {
      if (cancelled) return
      const liveRow = [...rows].reverse().find((row) => row.status === 'live')
      if (!liveRow) return
      setDeploymentId(liveRow.deployment_id)
      setDeployStatus('live')
      if (liveRow.production_url) setDeployUrl(resolvePreviewUrl(liveRow.production_url))
    }).catch(() => {})
    return () => { cancelled = true }
  }, [projectId])
  // Preview any served path (not only .html); fall back to index.html when unset.
  const previewServePath = previewPath || (projectId ? 'index.html' : null)
  const preview = usePreviewUrl(projectId, previewServePath)
  const previewUrl = preview.data?.url ?? null
  const previewHmr = preview.data?.mode === 'hmr'
  hmrModeRef.current = previewHmr

  // Preview bridge → Console tab + engine (Phase 1.5) and inspect (Phase 2.1).
  useEffect(() => {
    if (!projectId) return
    const onMessage = (event: MessageEvent) => {
      const data = event.data
      if (!data || typeof data !== 'object' || (data as { source?: string }).source !== 'loopit-preview') return
      const type = (data as { type?: string }).type
      if (type === 'inspect') {
        setInspectTarget({
          selector: String((data as { selector?: string }).selector || ''),
          snippet: String((data as { snippet?: string }).snippet || ''),
          loc: (data as { loc?: string | null }).loc ?? null,
          tag: (data as { tag?: string | null }).tag ?? null,
          text: String((data as { text?: string }).text || ''),
        })
        setInspectMode(false)
        return
      }
      if (type !== 'console') return
      const level = String((data as { level?: string }).level || 'log')
      const text = String((data as { text?: string }).text || '')
      if (!text) return
      setConsoleEntries((prev) => [
        ...prev.slice(-199),
        { id: `prev-${Date.now()}-${prev.length}`, level, text, at: new Date().toISOString(), source: 'preview' },
      ])
      if (level === 'error' || level === 'warn') {
        void reportConsoleError(projectId, { level, text, href: String((data as { href?: string }).href || '') }).catch(() => {})
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [projectId])

  // Tell the preview iframe to enter/leave inspect mode (Phase 2.1).
  useEffect(() => {
    const frame = previewIframeRef.current
    if (!frame?.contentWindow) return
    frame.contentWindow.postMessage(
      { source: 'loopit-parent', type: 'inspect-mode', enabled: inspectMode },
      '*',
    )
  }, [inspectMode, previewUrl, previewEpoch])
  const nodes = useMemo(() => (ui.dag ? orderedDagNodes(ui.dag) : []), [ui.dag])
  const verified = ui.checkpoints.find((checkpoint) => checkpoint.live && checkpoint.verified)
    ?? ui.checkpoints.find((checkpoint) => checkpoint.verified)
    ?? null

  const checkpointMutation = useCheckpointAction(runId, projectId, { live: !!live })
  const gateMutation = useGateDecision(runId)
  const gatesEnabled = useGatesEnabled()
  const startBuild = useStartBuild()
  const closeAction = useCallback(() => setAction(null), [])

  const runCheckpoint = (pending: CheckpointAction, reason: string) => {
    checkpointMutation.mutate({ pending, reason }, {
      onSuccess: (result) => {
        if (result.kind === 'deploy' && result.production_url) {
          setDeployUrl(result.production_url)
          setDeploymentId(result.deployment_id ?? null)
          setDeployStatus('live')
          toast.push('success', 'Your app is live')
        } else if (result.kind === 'fork') {
          toast.push('success', 'Copy saved')
          const forkedProjectId = result.project_id
          if (forkedProjectId) {
            // Open a new run on the forked project so the copy is reachable.
            const prompt = ui.run?.prompt ?? query.data?.prompt ?? 'Continue from this saved copy'
            startBuild.mutate({ prompt, projectId: forkedProjectId }, {
              onSuccess: (created) => router.push(`/build/?run=${encodeURIComponent(created.run_id)}`),
              onError: (cause) => toast.push('error', toUserFacingError(cause).message),
            })
          } else {
            toast.push('info', 'Copy saved, but the new project id was not returned')
          }
        } else if (result.kind === 'rollback') {
          setPreviewEpoch((n) => n + 1)
          toast.push('success', 'Rolled back to this version')
        }
        setAction(null)
      },
      onError: (cause) => toast.push('error', toUserFacingError(cause).message),
    })
  }

  const decideGate = (gate: ApprovalGate, approved: boolean) => {
    gateMutation.mutate({ gate, approved }, {
      onSuccess: (gateId) => setUi((prev) => ({ ...prev, gates: prev.gates.filter((g) => g.gate_id !== gateId) })),
      onError: (cause) => toast.push('error', toUserFacingError(cause).message),
    })
  }

  const handleSendMessage = (text: string): Promise<void> => {
    const trimmed = text.trim()
    if (!trimmed || sendMessage.isPending || startBuild.isPending) return Promise.resolve()
    const id = `${Date.now()}-user`
    setMessages((prev) => [...prev, { id, role: 'user', text: trimmed, at: new Date().toISOString(), pending: true }])
    const dropPending = () => setMessages((prev) => prev.filter((message) => message.id !== id))
    const fail = (cause: unknown) => {
      dropPending()
      toast.push('error', toUserFacingError(cause).message)
      throw cause
    }
    if (!live) {
      if (!projectId) return fail(new Error('This build has no project to continue'))
      return startBuild.mutateAsync({
        prompt: trimmed,
        projectId,
        mode: continueMode,
        tier: continueTier,
      }).then((created) => {
        router.push(`/build/?run=${encodeURIComponent(created.run_id)}`)
      }).catch(fail)
    }
    return sendMessage.mutateAsync(trimmed).then(() => undefined).catch(fail)
  }

  const handleCancel = () => {
    if (!live || cancel.isPending) return
    cancel.mutate(undefined, {
      onSuccess: () => toast.push('info', 'Build stopped'),
      onError: (cause) => toast.push('error', toUserFacingError(cause).message),
    })
  }

  /** Edit-and-resend: any earlier instruction can become the prompt of a new
   *  run against the same project, so a wrong turn is corrected by resending
   *  rather than by layering a patch on top of it. */
  const handleResend = (text: string) => {
    if (startBuild.isPending || !projectId) return
    startBuild.mutate({ prompt: text, projectId }, {
      onSuccess: (created) => router.push(`/build/?run=${encodeURIComponent(created.run_id)}`),
      onError: (cause) => toast.push('error', toUserFacingError(cause).message),
    })
  }

  /** Continue after a failed/stopped run: start a follow-up on the same project
   *  with the composer text (not just focus). Empty composer → focus instead. */
  const handleContinue = () => {
    const text = composerRef.current?.value?.trim() ?? ''
    if (!text) {
      composerRef.current?.focus()
      return
    }
    if (startBuild.isPending || !projectId) return
    startBuild.mutate({ prompt: text, projectId, mode: continueMode, tier: continueTier }, {
      onSuccess: (created) => router.push(`/build/?run=${encodeURIComponent(created.run_id)}`),
      onError: (cause) => toast.push('error', toUserFacingError(cause).message),
    })
  }

  /** Plan-mode Approve: start a Build run with the plan goal. */
  const handleApprovePlan = (background = false) => {
    const goal = ui.dag?.goal || ui.run?.prompt || query.data?.prompt
    if (!goal || !projectId || startBuild.isPending) return
    startBuild.mutate({ prompt: goal, projectId, mode: 'build', tier: continueTier, background }, {
      onSuccess: (created) => {
        if (background) {
          toast.push('success', 'Building in the background — we will notify you when it is ready to apply')
          router.push('/build')
          return
        }
        router.push(`/build/?run=${encodeURIComponent(created.run_id)}`)
      },
      onError: (cause) => toast.push('error', toUserFacingError(cause).message),
    })
  }

  const terminalFailed = ['error', 'failed', 'budget_exceeded', 'stalled', 'cancelled', 'canceled'].includes(status?.toLowerCase() ?? '')

  if (!runId || runId === '_') {
    return (
      <AppPage width="fill" title="Build" back={BACK} rail={<BuildSessionRail activeRunId={null} />}>
        <EmptyState title="Pick a build" body="Open a build from the board to see its progress and preview." action={<Link href="/build" className={btnPrimary}>Back to builds</Link>} />
      </AppPage>
    )
  }

  const fetchError = query.error
  const offline = fetchError ? isUnreachable(fetchError) || isServiceMissing(fetchError) : false
  const missing = fetchError instanceof ApiError && fetchError.status === 404 && !offline
  const title = runTitle(ui.run ?? query.data)
  const conversationId = runConversationId(ui.run ?? query.data)
  const startedAt = ui.run?.started_at || query.data?.started_at
  const files = ui.run?.files ?? []

  return (
    <AppPage
      width="fill"
      rail={<BuildSessionRail activeRunId={runId} />}
      back={projectId ? { href: `/build/projects/?id=${encodeURIComponent(projectId)}`, label: 'Build project' } : BACK}
      title={title}
      documentTitle="Build"
      meta={(
        <>
          {status && <Badge tone={statusTone(status)}>{statusLabel(status)}</Badge>}
          {(ui.run?.mode || query.data?.mode) && (
            <Badge tone="neutral">{(ui.run?.mode || query.data?.mode)} mode</Badge>
          )}
          {live && <StatusDot state="working" />}
          {startedAt && <Elapsed since={startedAt} live={!!live} />}
          {ui.cost?.credits_spent != null && ui.cost.credits_spent > 0 && (
            <span>{ui.cost.credits_spent.toFixed(3)} credits</span>
          )}
          <CostTransparencyBar
            tier={ui.run?.tier || query.data?.tier || continueTier}
            creditsSpent={ui.cost?.credits_spent}
            iterations={ui.cost?.iterations}
          />
        </>
      )}
      actions={(
        <div className="flex items-center gap-2">
          <NotificationsBell />
          {conversationId && (
            <Link href={`/chat/?conversation=${encodeURIComponent(conversationId)}`} className={btnGhost}>Open in Chat</Link>
          )}
          <Link href={PROJECTS.href} className={btnGhost}>{PROJECTS.label}</Link>
          {live ? (
            <button
              type="button"
              className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--danger-soft-border)] bg-[var(--danger-soft)] px-3 py-1.5 text-ui-xs font-medium text-[var(--danger)] hover:bg-[var(--danger-soft-hover)] transition"
              disabled={cancel.isPending}
              onClick={handleCancel}
            >
              <Square size={11} className="fill-current" /> Stop
            </button>
          ) : status ? (
            <>
              <EffortSwitch value={continueTier} onChange={setContinueTier} disabled={startBuild.isPending} />
              <ModeSwitch value={continueMode} onChange={setContinueMode} disabled={startBuild.isPending} />
              <button
                type="button"
                className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--border-strong)] bg-[var(--bg-hover-strong)] px-3 py-1.5 text-ui-xs font-medium text-[var(--ink-secondary)] hover:bg-[var(--bg-hover)] transition"
                disabled={startBuild.isPending || !projectId}
                onClick={handleContinue}
              >
                <Play size={12} /> Continue
              </button>
              {terminalFailed && <RetryButton run={ui.run ?? query.data} />}
            </>
          ) : null}
          <button
            type="button"
            className={btnPrimary}
            disabled={!verified || checkpointMutation.isPending}
            onClick={() => verified && setAction({ kind: 'deploy', checkpoint: verified })}
          >
            <Rocket size={13} className="mr-1.5 inline" />Publish
          </button>
        </div>
      )}
    >
      <div className="flex-1 min-h-0 overflow-y-auto">
      {query.isPending && <LoadingState variant="card" label="Loading build" />}

      {fetchError && (
        <ErrorNotice
          error={offline ? {
            kind: 'unavailable',
            title: 'Build service unreachable',
            message: 'Build is unavailable right now.',
            action: 'Retry in a moment.',
          } : missing ? {
            kind: 'unknown',
            title: 'Build not found',
            message: 'This build does not exist, or you do not have access to it.',
            action: 'Return to the build list.',
          } : toUserFacingError(fetchError)}
          onRetry={() => { void query.refetch() }}
        />
      )}

      {ui.error && (
        <div className="mt-4">
          <ErrorNotice error={toUserFacingError(new Error(ui.error))} onRetry={() => setUi((prev) => ({ ...prev, error: null }))} />
        </div>
      )}

      {deployUrl && (
        <div className="mt-4 flex flex-wrap items-center gap-3 rounded-xl border border-[var(--accent-soft-border)] bg-[var(--accent-soft)] p-4" role="status">
          <div className="min-w-0 flex-1">
            <p className="text-ui-sm font-medium text-[var(--accent-text)]">
              {deployStatus === 'unpublished' ? 'Publication paused' : 'Your app is live'}
            </p>
            <p className="mt-0.5 text-ui-xs text-[var(--ink-secondary)]">
              {deployStatus === 'unpublished'
                ? 'This link no longer serves the app. Re-publish to make it live again.'
                : 'Anyone with this link can open the app you just published. The link stays valid for 30 days.'}
            </p>
          </div>
          {deployStatus !== 'unpublished' && (
            <button
              type="button"
              className={btnGhost}
              onClick={() => {
                const absolute = deployUrl.startsWith('http') ? deployUrl : `${window.location.origin}${deployUrl}`
                void navigator.clipboard?.writeText(absolute).then(() => toast.push('success', 'Link copied'))
              }}
            >
              Copy link
            </button>
          )}
          {deployStatus !== 'unpublished' && (
            <a href={deployUrl} target="_blank" rel="noreferrer" className={btnPrimary}>Open app</a>
          )}
          {deploymentId && projectId && deployStatus === 'live' && (
            <button
              type="button"
              className={btnOutline}
              disabled={deployBusy}
              onClick={() => {
                setDeployBusy(true)
                void unpublishProject(projectId, deploymentId)
                  .then(() => {
                    setDeployStatus('unpublished')
                    toast.push('success', 'Publication paused')
                  })
                  .catch((cause) => toast.push('error', toUserFacingError(cause).message))
                  .finally(() => setDeployBusy(false))
              }}
            >
              Unpublish
            </button>
          )}
          {deploymentId && projectId && deployStatus === 'unpublished' && (
            <button
              type="button"
              className={btnPrimary}
              disabled={deployBusy}
              onClick={() => {
                setDeployBusy(true)
                void republishProject(projectId, deploymentId)
                  .then((result) => {
                    if (result.production_url) setDeployUrl(result.production_url)
                    setDeployStatus('live')
                    toast.push('success', 'Your app is live again')
                  })
                  .catch((cause) => toast.push('error', toUserFacingError(cause).message))
                  .finally(() => setDeployBusy(false))
              }}
            >
              Re-publish
            </button>
          )}
        </div>
      )}

      {(ui.run?.mode || query.data?.mode) === 'plan' && !live && (
        <section className="mt-4 rounded-xl border border-[var(--accent-soft-border)] bg-[var(--accent-soft)] p-4">
          <h2 className="text-ui-sm font-medium text-[var(--accent-text)]">Plan ready</h2>
          <p className="mt-1 text-ui-xs text-[var(--ink-secondary)]">
            Approve starts a Build run with this plan&apos;s goal. Build in background finishes detached and asks you to Apply changes (diff review) before merging into the main version line.
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <EffortSwitch value={continueTier} onChange={setContinueTier} disabled={startBuild.isPending} />
            <CostTransparencyBar tier={continueTier} />
          </div>
          <div className="mt-2">
            <EffortEstimateNotice tier={continueTier} mode="plan" />
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" className={btnPrimary} disabled={startBuild.isPending || !projectId} onClick={() => handleApprovePlan(false)}>
              Approve &amp; build
            </button>
            <button type="button" className={btnOutline} disabled={startBuild.isPending || !projectId} onClick={() => handleApprovePlan(true)}>
              Build in background
            </button>
            <button type="button" className={btnOutline} disabled={startBuild.isPending || !projectId} onClick={handleContinue}>Revise</button>
            <Link href="/build" className={btnGhost}>Cancel</Link>
          </div>
        </section>
      )}

      {!query.isPending && !fetchError && (
        <>
          {status && <StatusStepper status={status} />}
          {ui.fileChanges.length > 0 && (
            <section className={`${panelCls} mt-4 p-3`}>
              <SectionHeader title="Changed files" count={ui.fileChanges.length} />
              <FileChangeChips
                changes={ui.fileChanges}
                onOpen={(change) => {
                  setDiffChange(change)
                  setCodePath(change.path)
                  setCompareCheckpointId(null)
                }}
              />
            </section>
          )}
          <MobileBuildSplit
            sidebar={(
              <>
                <TaskGraph dagGoal={ui.dag?.goal ?? null} nodes={nodes} showCompleted={showCompleted} onToggle={() => setShowCompleted((value) => !value)} />
                <ActivityTimeline
                  activity={ui.activity}
                  running={!!live}
                  outcome={status ? {
                    status,
                    summary: ui.run?.summary ?? null,
                    iterations: ui.cost?.iterations,
                    credits: ui.cost?.credits_spent,
                  } : null}
                />
                <CheckpointList
                  checkpoints={ui.checkpoints}
                  runLive={!!live}
                  onAction={setAction}
                  onCompare={(checkpoint) => {
                    setCompareCheckpointId(checkpoint.checkpoint_id)
                    const path = previewPath || pickPreviewFile(files) || files[0] || null
                    if (path) setCodePath(path)
                  }}
                />
              </>
            )}
            preview={(
              <PreviewWorkspace
                runId={runId}
                projectId={projectId}
                files={files}
                selected={previewPath}
                onSelect={(path) => {
                  if (/\.html?$/i.test(path)) { setPreviewPath(path); setCodePath(path); setDiffChange(null) }
                  else { setCodePath(path); setDiffChange(null); setPreviewPath((current) => current ?? path) }
                }}
                codePath={codePath}
                diffChange={diffChange}
                compareCheckpointId={compareCheckpointId}
                onCloseCode={() => { setCodePath(null); setDiffChange(null); setCompareCheckpointId(null) }}
                url={previewUrl}
                epoch={previewEpoch}
                hmr={previewHmr}
                onReload={() => setPreviewEpoch((n) => n + 1)}
                loading={preview.isFetching}
                error={preview.isError ? toUserFacingError(preview.error).message : null}
                live={!!live}
                inspectMode={inspectMode}
                onToggleInspect={() => setInspectMode((v) => !v)}
                iframeRef={previewIframeRef}
              />
            )}
            chat={(
              <RunWorkspace
                runId={runId}
                projectId={projectId}
                previewUrl={previewUrl}
                messages={messages}
                streamingText={streamingText}
                terminalHistory={terminalHistory}
                onSetTerminalHistory={setTerminalHistory}
                consoleEntries={consoleEntries}
                onSendMessage={handleSendMessage}
                onResend={handleResend}
                onFixError={(text) => {
                  const prompt = `Fix this error:\n${text}`
                  if (live) handleSendMessage(prompt)
                  else handleResend(prompt)
                }}
                sendBusy={sendMessage.isPending || startBuild.isPending}
                terminalAllowed={terminalAllowed}
                terminalOpen={terminalOpen}
                onToggleTerminal={() => setTerminalOpen((v) => !v)}
                composerRef={composerRef}
                gates={gatesEnabled ? ui.gates : []}
                gatesBusy={gateMutation.isPending}
                onGateDecision={decideGate}
                inspectTarget={inspectTarget}
                onClearInspect={() => setInspectTarget(null)}
                onVisualEdit={async (kind, value) => {
                  if (!projectId || !inspectTarget) return
                  try {
                    const result = await applyVisualEdit(projectId, {
                      kind,
                      value,
                      selector: inspectTarget.selector,
                      snippet: inspectTarget.snippet,
                      loc: inspectTarget.loc,
                      tag: inspectTarget.tag,
                      text: inspectTarget.text,
                    })
                    if (result.applied) {
                      toast.push('success', result.message || 'Visual edit applied')
                      // HMR: do not remount; keep selection when possible (Phase 3.4).
                      if (!previewHmr) setPreviewEpoch((n) => n + 1)
                      if (shouldClearInspectAfterEdit({ applied: true, hmr: previewHmr, keepSelection: true })) {
                        setInspectTarget(null)
                      } else if (kind === 'text') {
                        setInspectTarget((prev) => prev ? { ...prev, text: value } : prev)
                      }
                    } else if (result.prompt) {
                      if (live) handleSendMessage(result.prompt)
                      else handleResend(result.prompt)
                      setInspectTarget(null)
                      toast.push('info', 'Sent edit to the builder')
                    }
                  } catch (cause) {
                    toast.push('error', toUserFacingError(cause).message)
                  }
                }}
              />
            )}
          />
        </>
      )}

      </div>
      <CheckpointDialog
        action={action}
        busy={checkpointMutation.isPending}
        versionLabel={action ? versionLabel(ui.checkpoints, action.checkpoint) : null}
        onCancel={closeAction}
        onConfirm={(reason) => { if (action) runCheckpoint(action, reason) }}
      />
    </AppPage>
  )
}

/** "Version N" for a checkpoint, counted from the project's first snapshot. */
function versionLabel(checkpoints: CheckpointView[], target: CheckpointView): string {
  const index = checkpoints.findIndex((checkpoint) => checkpoint.checkpoint_id === target.checkpoint_id)
  return `Version ${index >= 0 ? index + 1 : checkpoints.length}`
}

/** Ticking elapsed timer next to the status badge ("3m 12s"). */
function Elapsed({ since, live }: { since: string; live: boolean }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!live) return
    const t = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(t)
  }, [live])
  const start = new Date(since).getTime()
  if (Number.isNaN(start)) return <span>Created {formatWhen(since)}</span>
  const seconds = Math.max(0, Math.floor((now - start) / 1000))
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return <span className="tabular-nums">{m > 0 ? `${m}m ${String(s).padStart(2, '0')}s` : `${s}s`}</span>
}

/** Planning → Building → Verifying → Done. Queued and approval use their own labels. */
function StatusStepper({ status }: { status: string }) {
  const { steps, current: stage, failed } = statusStepper(status)
  return (
    <ol className="mt-4 flex items-center gap-1.5" aria-label="Build stage">
      {steps.map((label, index) => {
        const done = index < stage || (!failed && stage === 3 && index <= 3)
        const current = !failed && index === stage && stage !== 3
        const broke = failed && index === Math.min(stage, 2)
        return (
          <li key={label} className="flex items-center gap-1.5">
            <span className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 text-2xs font-medium ${
              broke ? 'bg-[var(--danger-soft)] text-[var(--danger)]'
              : current ? 'bg-[var(--accent-soft)] text-[var(--accent-text)]'
              : done ? 'text-[var(--success)]'
              : 'text-[var(--ink-muted)]'
            }`}>
              {done ? <CheckCircle2 size={11} /> : broke ? <AlertTriangle size={11} /> : current ? <Loader2 size={11} className="animate-spin" /> : <span className="w-[11px] h-[11px] rounded-full border border-current opacity-40 inline-block" />}
              {label}
            </span>
            {index < steps.length - 1 && <ChevronRight size={11} className="text-[var(--ink-muted)] opacity-50" />}
          </li>
        )
      })}
    </ol>
  )
}

/** The build's plan, in the words the engine prepared for a person. */
function TaskGraph({ dagGoal, nodes, showCompleted, onToggle }: { dagGoal: string | null; nodes: TaskNodeView[]; showCompleted: boolean; onToggle: () => void }) {
  const completed = nodes.filter(isCompletedNode)
  const visible = showCompleted ? nodes : nodes.filter((node) => !isCompletedNode(node))
  return (
    <section className={`${panelCls} p-4`}>
      <SectionHeader
        title="What we're doing"
        count={nodes.length}
        action={completed.length > 0 ? (
          <button type="button" className={btnGhost} onClick={onToggle}>{showCompleted ? 'Hide finished steps' : `Show ${completed.length} finished`}</button>
        ) : undefined}
      />
      {!nodes.length && <EmptyState title="Planning your build" body="The plan appears here once the builder has read your request." />}
      {dagGoal && <p className="mt-2 text-ui-sm text-[var(--ink-secondary)]">{dagGoal}</p>}
      <ol className="mt-3 space-y-2">
        {visible.map((node) => (
          <li key={node.id} className="rounded-lg border border-[var(--border-subtle)] p-3">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={statusTone(node.status ?? 'pending')}>{statusLabel(node.status ?? 'pending')}</Badge>
              {node.destructive && <Badge tone="rose">Needs your approval</Badge>}
            </div>
            <p className="mt-1.5 text-ui-sm text-[var(--ink-primary)]">{node.goal}</p>
            {node.destructive_reason && <p className="mt-1 text-ui-xs text-[var(--ink-muted)]">{node.destructive_reason}</p>}
          </li>
        ))}
      </ol>
    </section>
  )
}

function CheckpointList({ checkpoints, runLive, onAction, onCompare }: {
  checkpoints: CheckpointView[]
  runLive: boolean
  onAction: (action: CheckpointAction) => void
  onCompare?: (checkpoint: CheckpointView) => void
}) {
  // Latest version first; each row carries its own number from the start.
  const ordered = checkpoints.map((checkpoint, index) => ({ checkpoint, version: index + 1 })).reverse()
  return (
    <section className={`${panelCls} p-4`}>
      <SectionHeader title="Versions" count={checkpoints.length} />
      {!checkpoints.length && <EmptyState title="No versions yet" body="The builder saves a version every time the app passes its checks." />}
      <div className="mt-3 space-y-3">
        {ordered.map(({ checkpoint, version }) => (
          <article key={checkpoint.checkpoint_id} className="rounded-lg border border-[var(--border-subtle)] p-3">
            <div className="flex flex-wrap items-center gap-2">
              <strong className="text-ui-sm font-medium text-[var(--ink-primary)]">Version {version}</strong>
              {checkpoint.live && <Badge tone="green">Current</Badge>}
              {checkpoint.verified && <Badge tone="green">Verified</Badge>}
            </div>
            <p className="mt-1 text-ui-xs text-[var(--ink-muted)]">Saved {formatWhen(checkpoint.created_at)}</p>
            <div className="mt-2 flex flex-wrap gap-2">
              <button
                type="button"
                className={btnGhost}
                disabled={!checkpoint.verified || runLive}
                title={runLive ? 'Stop the build before rolling back' : undefined}
                onClick={() => onAction({ kind: 'rollback', checkpoint })}
              >
                Roll back here
              </button>
              <button type="button" className={btnGhost} onClick={() => onAction({ kind: 'fork', checkpoint })}>Save a copy</button>
              {onCompare && (
                <button type="button" className={btnGhost} onClick={() => onCompare(checkpoint)}>Compare</button>
              )}
              <button type="button" className={btnPrimary} disabled={!checkpoint.verified} onClick={() => onAction({ kind: 'deploy', checkpoint })}>Publish</button>
            </div>
          </article>
        ))}
      </div>
    </section>
  )
}

/** Classify an activity row for its timeline icon from structured kind/tone first. */
function activityIcon(item: Activity): { Icon: typeof FileText; cls: string } {
  if (item.tone === 'bad') return { Icon: AlertTriangle, cls: 'text-[var(--danger)]' }
  if (item.kind === 'verification.completed') {
    return item.tone === 'good'
      ? { Icon: ShieldCheck, cls: 'text-[var(--success)]' }
      : { Icon: AlertTriangle, cls: 'text-[var(--danger)]' }
  }
  if (item.kind === 'tool.called' || item.kind === 'tool.result' || item.kind === 'tool.completed') {
    const tool = item.tool ?? ''
    if (tool === 'apply_patch') return { Icon: FileCode2, cls: 'text-[var(--accent-text)]' }
    if (tool === 'read_file' || tool === 'search_code') return { Icon: FileText, cls: 'text-[var(--ink-muted)]' }
    if (tool === 'deploy') return { Icon: Rocket, cls: 'text-[var(--success)]' }
    return { Icon: Sparkles, cls: 'text-[var(--accent-text)]' }
  }
  if (item.kind === 'task.started' || item.kind === 'task.completed' || item.kind === 'task.stopped') {
    return item.tone === 'good'
      ? { Icon: CheckCircle2, cls: 'text-[var(--success)]' }
      : { Icon: Sparkles, cls: 'text-[var(--accent-text)]' }
  }
  if (item.kind) {
    return item.tone === 'good'
      ? { Icon: CheckCircle2, cls: 'text-[var(--success)]' }
      : { Icon: ChevronRight, cls: 'text-[var(--ink-muted)]' }
  }
  const text = `${item.title} ${item.body ?? ''}`.toLowerCase()
  if (/fail|error|reject|stall|denied|crash/.test(text)) return { Icon: AlertTriangle, cls: 'text-[var(--danger)]' }
  if (/verif|check|test|lint|typecheck|smoke/.test(text)) return { Icon: ShieldCheck, cls: 'text-[var(--success)]' }
  if (/patch|created|modified|wrote|applied|edit/.test(text)) return { Icon: FileCode2, cls: 'text-[var(--accent-text)]' }
  if (/read|search|scan|look/.test(text)) return { Icon: FileText, cls: 'text-[var(--ink-muted)]' }
  if (/model|think|brief|plan/.test(text)) return { Icon: Sparkles, cls: 'text-[var(--accent-text)]' }
  if (/deploy|publish|live/.test(text)) return { Icon: Rocket, cls: 'text-[var(--success)]' }
  return { Icon: ChevronRight, cls: 'text-[var(--ink-muted)]' }
}

function formatActivityAt(at: string): string {
  if (/^\d{4}-\d{2}-\d{2}/.test(at)) return formatWhen(at) || at
  return at
}

function ActivityTimeline({ activity, running, outcome }: { activity: Activity[]; running: boolean; outcome: { status: string; summary: string | null; iterations?: number; credits?: number } | null }) {
  const scrollRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = scrollRef.current
    if (el && running) el.scrollTop = el.scrollHeight
  }, [activity.length, running])

  return (
    <section className={`${panelCls} p-4`}>
      <SectionHeader title="Progress" />
      {outcome && !running && (
        <div className={`mt-3 rounded-lg border p-3 ${outcome.status === 'verified' ? 'border-[var(--success-border,var(--border-strong))] bg-[var(--bg-tint)]' : 'border-[var(--border-subtle)] bg-[var(--bg-sunken)]'}`}>
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={statusTone(outcome.status)}>{statusLabel(outcome.status)}</Badge>
            {outcome.iterations != null && <span className="text-3xs text-[var(--ink-muted)]">{outcome.iterations} recovery iteration{outcome.iterations === 1 ? '' : 's'}</span>}
            {outcome.credits != null && outcome.credits > 0 && <span className="text-3xs text-[var(--ink-muted)]">{outcome.credits.toFixed(3)} credits</span>}
          </div>
          {outcome.summary && <p className="mt-1.5 text-ui-xs text-[var(--ink-secondary)]">{outcome.summary}</p>}
        </div>
      )}
      {!activity.length && !running && !outcome && <EmptyState title="Nothing to report yet" body="Updates appear here while the builder works." />}
      <div ref={scrollRef} className="mt-3 max-h-96 space-y-0.5 overflow-auto">
        {activity.map((item) => {
          const { Icon, cls } = activityIcon(item)
          return (
            <article key={item.id} className="flex gap-2.5 rounded-lg px-1.5 py-1.5 hover:bg-[var(--bg-hover)] transition">
              <Icon size={13} className={`mt-0.5 shrink-0 ${cls}`} aria-hidden />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-2">
                  <strong className="text-ui-xs font-medium text-[var(--ink-primary)] truncate">{item.title}</strong>
                  <span className="text-3xs text-[var(--ink-muted)] shrink-0">{formatActivityAt(item.at)}</span>
                </div>
                {item.body && <p className="mt-0.5 break-words text-2xs text-[var(--ink-muted)] line-clamp-2">{item.body}</p>}
              </div>
            </article>
          )
        })}
        {running && (
          <div className="flex items-center gap-2.5 px-1.5 py-2 text-ui-xs text-[var(--ink-secondary)]">
            <Loader2 size={13} className="animate-spin text-[var(--accent-text)]" aria-hidden />
            Working…
          </div>
        )}
      </div>
    </section>
  )
}

/** The hero: a browser-chrome workspace around the live preview. */
function PreviewWorkspace({
  runId, projectId, files, selected, onSelect, codePath, diffChange, compareCheckpointId, onCloseCode, url, epoch, hmr = false, onReload, loading, error, live, className = '',
  inspectMode = false, onToggleInspect, iframeRef,
}: {
  runId: string
  projectId: string | null
  files: string[]
  selected: string | null
  onSelect: (path: string) => void
  codePath: string | null
  diffChange: FileChange | null
  compareCheckpointId: string | null
  onCloseCode: () => void
  url: string | null
  epoch: number
  hmr?: boolean
  onReload: () => void
  loading: boolean
  error: string | null
  live: boolean
  className?: string
  inspectMode?: boolean
  onToggleInspect?: () => void
  iframeRef?: React.RefObject<HTMLIFrameElement | null>
}) {
  const [device, setDevice] = useState<PreviewDevice>('desktop')
  const [customWidth, setCustomWidth] = useState<number>(1024)
  const [showCustom, setShowCustom] = useState(false)
  const [routeInput, setRouteInput] = useState(selected || 'index.html')
  const [navHistory, setNavHistory] = useState<string[]>([selected || 'index.html'])
  const [historyIndex, setHistoryIndex] = useState(0)
  const [filesOpen, setFilesOpen] = useState(false)
  const [seoOpen, setSeoOpen] = useState(false)
  const [seo, setSeo] = useState<PreviewMeta | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const routes = useMemo(() => previewRouteOptions(files), [files])
  const maxWidth = previewMaxWidth(device, customWidth)

  useEffect(() => {
    if (selected) setRouteInput(selected)
  }, [selected])

  useEffect(() => {
    if (!filesOpen) return
    const close = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) setFilesOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [filesOpen])

  useEffect(() => {
    if (!seoOpen || !projectId) return
    let cancelled = false
    void getPreviewMeta(projectId, normalizePreviewRoute(routeInput))
      .then((meta) => { if (!cancelled) setSeo(meta) })
      .catch(() => { if (!cancelled) setSeo(null) })
    return () => { cancelled = true }
  }, [seoOpen, projectId, routeInput])

  const navigateTo = (raw: string, push = true) => {
    const path = normalizePreviewRoute(raw)
    setRouteInput(path)
    onSelect(path)
    if (!push) return
    setNavHistory((prev) => {
      const next = [...prev.slice(0, historyIndex + 1), path]
      setHistoryIndex(next.length - 1)
      return next
    })
  }

  const goBack = () => {
    if (historyIndex <= 0) return
    const next = historyIndex - 1
    setHistoryIndex(next)
    const path = navHistory[next]!
    setRouteInput(path)
    onSelect(path)
  }

  const goForward = () => {
    if (historyIndex >= navHistory.length - 1) return
    const next = historyIndex + 1
    setHistoryIndex(next)
    const path = navHistory[next]!
    setRouteInput(path)
    onSelect(path)
  }

  return (
    <section className={`${panelCls} overflow-hidden flex flex-col min-w-0 min-h-[78vh] ${className}`}>
      <div className="flex items-center gap-1.5 px-3 py-2 border-b border-[var(--border-subtle)] shrink-0 flex-wrap">
        <span className="flex items-center gap-1.5 mr-1 shrink-0" aria-hidden>
          <i className="w-2.5 h-2.5 rounded-full bg-[var(--danger)] opacity-70 block" />
          <i className="w-2.5 h-2.5 rounded-full bg-[var(--warning)] opacity-70 block" />
          <i className="w-2.5 h-2.5 rounded-full bg-[var(--success)] opacity-70 block" />
        </span>
        <button type="button" onClick={goBack} disabled={historyIndex <= 0} title="Back" className="p-1.5 rounded-lg text-[var(--ink-muted)] hover:bg-[var(--bg-hover)] disabled:opacity-40 transition shrink-0">
          <ArrowLeft size={13} aria-hidden />
        </button>
        <button type="button" onClick={goForward} disabled={historyIndex >= navHistory.length - 1} title="Forward" className="p-1.5 rounded-lg text-[var(--ink-muted)] hover:bg-[var(--bg-hover)] disabled:opacity-40 transition shrink-0">
          <ArrowRight size={13} aria-hidden />
        </button>
        <div className="flex-1 min-w-[12rem] flex items-center gap-1.5 rounded-lg bg-[var(--bg-sunken)] border border-[var(--border-subtle)] px-2 py-1 text-ui-xs text-[var(--ink-secondary)]">
          {live ? <Loader2 size={11} className="animate-spin shrink-0 text-[var(--accent-text)]" aria-hidden /> : <Monitor size={11} className="shrink-0" aria-hidden />}
          <input
            value={routeInput}
            onChange={(e) => setRouteInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') navigateTo(routeInput) }}
            list="loopit-preview-routes"
            placeholder="index.html"
            className="flex-1 min-w-0 bg-transparent font-mono text-2xs text-[var(--ink-primary)] focus:outline-none"
            aria-label="Preview URL path"
          />
          <datalist id="loopit-preview-routes">
            {routes.map((route) => <option key={route} value={route} />)}
          </datalist>
        </div>
        <select
          className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-1.5 py-1 text-3xs text-[var(--ink-secondary)]"
          value={routes.includes(routeInput) ? routeInput : ''}
          onChange={(e) => { if (e.target.value) navigateTo(e.target.value) }}
          aria-label="Route picker"
        >
          <option value="">Route…</option>
          {routes.map((route) => <option key={route} value={route}>{route}</option>)}
        </select>
        {!!files.length && (
          <div className="relative shrink-0" ref={menuRef}>
            <button type="button" className={btnGhost} onClick={() => setFilesOpen((v) => !v)} aria-expanded={filesOpen}>
              <FileCode2 size={12} className="mr-1 inline" />Files ({files.length})<ChevronDown size={11} className="ml-1 inline" />
            </button>
            {filesOpen && (
              <div className="absolute right-0 z-20 mt-1 max-h-72 w-64 overflow-auto rounded-xl border border-[var(--border-strong)] bg-[var(--bg-overlay)] p-1.5 shadow-panel">
                {files.map((path) => (
                  <button
                    key={path}
                    type="button"
                    onClick={() => { onSelect(path); setFilesOpen(false) }}
                    className={`w-full truncate rounded-lg px-2.5 py-1.5 text-left font-mono text-2xs transition ${path === selected || path === codePath ? 'bg-[var(--accent-soft)] text-[var(--accent-text)]' : 'text-[var(--ink-secondary)] hover:bg-[var(--bg-hover)]'}`}
                  >
                    {path}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        <button type="button" onClick={() => setDevice('desktop')} aria-pressed={device === 'desktop'} title="Desktop width" className={`p-1.5 rounded-lg transition shrink-0 ${device === 'desktop' ? 'text-[var(--accent-text)] bg-[var(--accent-soft)]' : 'text-[var(--ink-muted)] hover:bg-[var(--bg-hover)]'}`}>
          <Monitor size={13} aria-hidden />
        </button>
        <button type="button" onClick={() => setDevice('tablet')} aria-pressed={device === 'tablet'} title="Tablet width (768)" className={`p-1.5 rounded-lg transition shrink-0 ${device === 'tablet' ? 'text-[var(--accent-text)] bg-[var(--accent-soft)]' : 'text-[var(--ink-muted)] hover:bg-[var(--bg-hover)]'}`}>
          <Tablet size={13} aria-hidden />
        </button>
        <button type="button" onClick={() => setDevice('mobile')} aria-pressed={device === 'mobile'} title="Mobile width" className={`p-1.5 rounded-lg transition shrink-0 ${device === 'mobile' ? 'text-[var(--accent-text)] bg-[var(--accent-soft)]' : 'text-[var(--ink-muted)] hover:bg-[var(--bg-hover)]'}`}>
          <Smartphone size={13} aria-hidden />
        </button>
        <button type="button" onClick={() => { setDevice('custom'); setShowCustom((v) => !v) }} aria-pressed={device === 'custom'} title="Custom width" className={`px-1.5 py-1 rounded-lg text-3xs transition shrink-0 ${device === 'custom' ? 'text-[var(--accent-text)] bg-[var(--accent-soft)]' : 'text-[var(--ink-muted)] hover:bg-[var(--bg-hover)]'}`}>
          Custom
        </button>
        {showCustom && device === 'custom' && (
          <input
            type="number"
            min={320}
            max={2400}
            value={customWidth}
            onChange={(e) => setCustomWidth(Number(e.target.value) || 1024)}
            className="w-16 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-1.5 py-1 text-3xs font-mono"
            aria-label="Custom preview width"
          />
        )}
        <button type="button" onClick={() => setSeoOpen((v) => !v)} aria-pressed={seoOpen} title="Social / SEO card" className={`px-1.5 py-1 rounded-lg text-3xs transition shrink-0 ${seoOpen ? 'text-[var(--accent-text)] bg-[var(--accent-soft)]' : 'text-[var(--ink-muted)] hover:bg-[var(--bg-hover)]'}`}>
          SEO
        </button>
        <button type="button" onClick={onToggleInspect} aria-pressed={inspectMode} title="Click to edit (select an element)" className={`p-1.5 rounded-lg transition shrink-0 ${inspectMode ? 'text-[var(--accent-text)] bg-[var(--accent-soft)]' : 'text-[var(--ink-muted)] hover:bg-[var(--bg-hover)]'}`}>
          <Crosshair size={13} aria-hidden />
        </button>
        <button type="button" onClick={onReload} title="Reload preview" className="p-1.5 rounded-lg text-[var(--ink-muted)] hover:bg-[var(--bg-hover)] transition shrink-0">
          <RotateCw size={13} aria-hidden />
        </button>
        {url && (
          <a href={url} target="_blank" rel="noreferrer" title="Open in a new tab" className="p-1.5 rounded-lg text-[var(--ink-muted)] hover:bg-[var(--bg-hover)] transition shrink-0">
            <ExternalLink size={13} aria-hidden />
          </a>
        )}
      </div>

      {seoOpen && (
        <div className="border-b border-[var(--border-subtle)] bg-[var(--bg-tint)] px-3 py-2 text-2xs shrink-0">
          <p className="font-medium text-[var(--ink-primary)]">{seo?.og_title || seo?.title || 'Untitled preview'}</p>
          <p className="mt-0.5 text-[var(--ink-muted)]">{seo?.description || 'No meta description yet.'}</p>
          {seo?.og_image && <p className="mt-0.5 truncate font-mono text-3xs text-[var(--ink-secondary)]">og:image {seo.og_image}</p>}
        </div>
      )}

      <div className="relative flex-1 min-h-0 bg-[var(--bg-sunken)] flex justify-center">
        <div className="h-full w-full transition-[max-width] duration-300" style={{ maxWidth }}>
          {error && <p className="m-3 text-ui-sm text-[var(--danger)]" role="alert">{error}</p>}
          {!error && loading && !url && <LoadingState label="Loading preview…" />}
          {!error && !url && !loading && (
            <EmptyState
              title={live ? 'Building the first page' : 'No preview yet'}
              body={live ? 'The preview appears here as soon as the builder writes the page.' : 'The first page appears here once it is ready.'}
            />
          )}
          {url && (
            <iframe
              ref={iframeRef}
              key={previewIframeKey({ url, epoch, hmr })}
              title="Build preview"
              sandbox={PREVIEW_SANDBOX}
              referrerPolicy="no-referrer"
              src={url}
              className="h-full w-full border-0 bg-white"
              onLoad={() => {
                if (!inspectMode || !iframeRef?.current?.contentWindow) return
                iframeRef.current.contentWindow.postMessage(
                  { source: 'loopit-parent', type: 'inspect-mode', enabled: true },
                  '*',
                )
              }}
            />
          )}
        </div>

        {codePath && (
          <CodeEditorDrawer
            runId={runId}
            projectId={projectId}
            files={files}
            path={codePath}
            diffChange={diffChange}
            compareCheckpointId={compareCheckpointId}
            onClose={onCloseCode}
            onSelectPath={(path) => onSelect(path)}
            live={live}
            onSaved={() => {
              if (!hmr) onReload()
            }}
          />
        )}
      </div>
    </section>
  )
}

/** The builder's turn, rendered from the raw model text. A JSON tool call
 *  becomes a compact action card; anything else renders as written. */
function AssistantTurn({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false)
  const call = parseToolTurn(text)
  if (!call) return <span className="whitespace-pre-wrap break-words">{text}</span>
  return (
    <div>
      <button
        type="button"
        onClick={() => call.expandable && setExpanded((v) => !v)}
        className={`flex w-full items-center gap-2 font-mono text-left ${call.expandable ? 'cursor-pointer' : 'cursor-default'}`}
        aria-expanded={call.expandable ? expanded : undefined}
      >
        <FileCode2 size={11} className="shrink-0 text-[var(--accent-text)]" aria-hidden />
        <span className="font-medium text-[var(--accent-text)]">{call.tool}</span>
        {call.detail && <span className="truncate text-[var(--ink-muted)]">{call.detail}</span>}
        {call.expandable && <ChevronDown size={10} className={`ml-auto shrink-0 transition-transform ${expanded ? 'rotate-180' : ''}`} aria-hidden />}
      </button>
      {expanded && call.full && (
        <pre className="mt-2 max-h-64 overflow-auto rounded-lg bg-[var(--bg-base)] p-2 text-3xs leading-relaxed text-[var(--ink-secondary)] whitespace-pre-wrap break-words">{call.full}</pre>
      )}
    </div>
  )
}

function parseToolTurn(text: string): { tool: string; detail: string | null; full: string | null; expandable: boolean } | null {
  try {
    const parsed = JSON.parse(text) as { tool?: unknown; args?: Record<string, unknown> }
    if (!parsed || typeof parsed.tool !== 'string') return null
    const args = parsed.args ?? {}
    const patch = typeof args.patch === 'string' ? args.patch : null
    const detail =
      typeof args.path === 'string' ? args.path
      : typeof args.query === 'string' ? `"${args.query}"`
      : patch ? `${patch.split('\n').length} lines`
      : null
    return { tool: parsed.tool, detail, full: patch, expandable: patch != null }
  } catch {
    return null
  }
}

/** Start a follow-up run with the same prompt and project, keeping the workspace. */
function RetryButton({ run }: { run: RunSummary | null | undefined }) {
  const router = useRouter()
  const toast = useToast()
  const start = useStartBuild()
  if (!run) return null
  return (
    <button
      type="button"
      className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--border-strong)] bg-[var(--bg-hover-strong)] px-3 py-1.5 text-ui-xs font-medium text-[var(--ink-secondary)] hover:bg-[var(--bg-hover)] transition"
      disabled={start.isPending}
      onClick={async () => {
        try {
          const created = await start.mutateAsync({ prompt: run.prompt, projectId: run.project_id })
          router.push(`/build/?run=${encodeURIComponent(created.run_id)}`)
        } catch (cause) { toast.push('error', toUserFacingError(cause).message) }
      }}
    >
      <RotateCw size={12} /> Retry
    </button>
  )
}

/** Bottom workspace: instructions, console, database, security, tests, and terminal. */
function RunWorkspace({
  runId, projectId, previewUrl, messages, streamingText, terminalHistory, onSetTerminalHistory, consoleEntries, onSendMessage, onResend, onFixError, sendBusy, terminalAllowed, terminalOpen, onToggleTerminal, composerRef, gates, gatesBusy, onGateDecision,
  inspectTarget, onClearInspect, onVisualEdit,
}: {
  runId: string
  projectId: string | null
  previewUrl: string | null
  messages: ChatMessage[]
  streamingText: string | null
  terminalHistory: TerminalEntry[]
  onSetTerminalHistory: React.Dispatch<React.SetStateAction<TerminalEntry[]>>
  consoleEntries: ConsoleEntry[]
  onSendMessage: (text: string) => void | Promise<void>
  onResend: (text: string) => void
  onFixError: (text: string) => void
  sendBusy: boolean
  terminalAllowed: boolean
  terminalOpen: boolean
  onToggleTerminal: () => void
  composerRef: React.RefObject<HTMLTextAreaElement | null>
  gates: ApprovalGate[]
  gatesBusy: boolean
  onGateDecision: (gate: ApprovalGate, approved: boolean) => void
  inspectTarget: InspectTarget | null
  onClearInspect: () => void
  onVisualEdit: (kind: 'text' | 'color' | 'spacing' | 'class', value: string) => void | Promise<void>
}) {
  const [tab, setTab] = useState<'chat' | 'console' | 'database' | 'security' | 'tests' | 'terminal'>('chat')
  const active = terminalAllowed && terminalOpen ? 'terminal' : tab === 'terminal' ? 'chat' : tab
  return (
    <section className={`${panelCls} mt-4 overflow-hidden flex flex-col`}>
      <div className="flex items-center gap-2 border-b border-[var(--border-subtle)] px-3 py-2 shrink-0 flex-wrap">
        <RunWorkspaceTab active={active === 'chat'} onClick={() => { setTab('chat'); if (terminalOpen) onToggleTerminal() }} icon={Send} label="Workspace" />
        <RunWorkspaceTab active={active === 'console'} onClick={() => { setTab('console'); if (terminalOpen) onToggleTerminal() }} icon={AlertTriangle} label="Console" />
        <RunWorkspaceTab active={active === 'database'} onClick={() => { setTab('database'); if (terminalOpen) onToggleTerminal() }} icon={Database} label="Database" />
        <RunWorkspaceTab active={active === 'security'} onClick={() => { setTab('security'); if (terminalOpen) onToggleTerminal() }} icon={Shield} label="Security" />
        <RunWorkspaceTab active={active === 'tests'} onClick={() => { setTab('tests'); if (terminalOpen) onToggleTerminal() }} icon={FlaskConical} label="Tests" />
        {terminalAllowed && (
          <RunWorkspaceTab active={active === 'terminal'} onClick={() => { setTab('terminal'); if (!terminalOpen) onToggleTerminal() }} icon={Terminal} label="Terminal" />
        )}
      </div>
      <div className="min-h-[220px] max-h-[40vh] flex flex-col">
        {active === 'terminal' ? (
          <TerminalPane projectId={projectId} history={terminalHistory} onHistoryChange={onSetTerminalHistory} />
        ) : active === 'console' ? (
          <RunConsole entries={consoleEntries} onFixError={onFixError} />
        ) : active === 'database' ? (
          <DatabasePanel projectId={projectId} />
        ) : active === 'security' ? (
          <SecurityPanel projectId={projectId} />
        ) : active === 'tests' ? (
          <BrowserTestsPanel projectId={projectId} previewUrl={previewUrl} />
        ) : (
          <RunChat
            messages={messages}
            streamingText={streamingText}
            onSend={onSendMessage}
            onResend={onResend}
            busy={sendBusy}
            composerRef={composerRef}
            gates={gates}
            gatesBusy={gatesBusy}
            onGateDecision={onGateDecision}
            inspectTarget={inspectTarget}
            onClearInspect={onClearInspect}
            onVisualEdit={onVisualEdit}
          />
        )}
      </div>
    </section>
  )
}

function RunConsole({ entries, onFixError }: { entries: ConsoleEntry[]; onFixError: (text: string) => void }) {
  const scrollRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [entries.length])
  return (
    <div className="flex flex-1 min-h-0 flex-col">
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-auto bg-black p-3 font-mono text-2xs space-y-2">
        {entries.length === 0 && (
          <p className="text-[var(--ink-muted)]">Preview console and sandbox logs appear here.</p>
        )}
        {entries.map((entry) => (
          <div key={entry.id} className="group">
            <div className={`whitespace-pre-wrap break-words ${entry.level === 'error' ? 'text-red-400' : entry.level === 'warn' ? 'text-amber-300' : 'text-zinc-300'}`}>
              <span className="opacity-50">[{entry.source}/{entry.level}] </span>
              {entry.text}
            </div>
            {(entry.level === 'error' || entry.level === 'warn') && (
              <button
                type="button"
                onClick={() => onFixError(entry.text)}
                className="mt-1 inline-flex items-center gap-1 text-3xs text-[var(--accent-text)] opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
              >
                <Sparkles size={9} /> Fix this error
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

function RunWorkspaceTab({ active, onClick, icon: Icon, label }: { active: boolean; onClick: () => void; icon: typeof Send; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-2xs font-medium transition ${
        active ? 'bg-[var(--accent-soft)] text-[var(--accent-text)]' : 'text-[var(--ink-muted)] hover:bg-[var(--bg-hover)]'
      }`}
    >
      <Icon size={11} /> {label}
    </button>
  )
}

function RunChat({ messages, streamingText, onSend, onResend, busy, composerRef, gates = [], gatesBusy = false, onGateDecision, inspectTarget = null, onClearInspect, onVisualEdit }: {
  messages: ChatMessage[]
  streamingText: string | null
  onSend: (text: string) => void | Promise<void>
  onResend: (text: string) => void
  busy: boolean
  composerRef: React.RefObject<HTMLTextAreaElement | null>
  gates?: ApprovalGate[]
  gatesBusy?: boolean
  onGateDecision?: (gate: ApprovalGate, approved: boolean) => void
  inspectTarget?: InspectTarget | null
  onClearInspect?: () => void
  onVisualEdit?: (kind: 'text' | 'color' | 'spacing' | 'class', value: string) => void | Promise<void>
}) {
  const [text, setText] = useState('')
  const [editValue, setEditValue] = useState('')
  const [editKind, setEditKind] = useState<'text' | 'color' | 'spacing'>('text')
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages.length, gates.length])

  useEffect(() => {
    if (inspectTarget?.text) {
      setEditValue(inspectTarget.text)
      setEditKind('text')
    }
  }, [inspectTarget])

  const submit = () => {
    if (!text.trim() || busy) return
    const draft = text
    const payload = inspectTarget
      ? `${text.trim()}\n\n(editing ${inspectTarget.tag || 'element'}${inspectTarget.loc ? ` at ${inspectTarget.loc}` : ''}: ${inspectTarget.selector})`
      : text
    setText('')
    onClearInspect?.()
    const pending = onSend(payload)
    if (pending && typeof pending.then === 'function') {
      void pending.catch(() => setText(draft))
    }
  }

  return (
    <div className="flex flex-1 min-h-0 flex-col">
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-auto p-3 space-y-3">
        {messages.length === 0 && gates.length === 0 && (
          <p className="text-2xs text-[var(--ink-muted)]">Steer the builder while it runs, or continue after it stops.</p>
        )}
        {gates.length > 0 && onGateDecision && (
          <div className="space-y-2">
            {gates.map((gate) => (
              <article key={gate.gate_id} className="rounded-xl border border-[var(--accent-soft-border)] bg-[var(--accent-soft)] p-3">
                <p className="text-ui-xs font-medium text-[var(--accent-text)]">{gateTitle(gate.action)}</p>
                {gate.reason && <p className="mt-1 text-2xs text-[var(--ink-secondary)]">{gate.reason}</p>}
                <div className="mt-2 flex gap-2">
                  <button type="button" className={`${btnPrimary} text-2xs`} disabled={gatesBusy} onClick={() => onGateDecision(gate, true)}>Approve</button>
                  <button type="button" className={`${btnOutline} text-2xs`} disabled={gatesBusy} onClick={() => onGateDecision(gate, false)}>Decline</button>
                </div>
              </article>
            ))}
          </div>
        )}
        {messages.map((m) => (
          <div key={m.id} className={`group flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-[80%] rounded-xl px-3 py-2 text-ui-xs ${
              m.role === 'user'
                ? 'bg-[var(--accent-soft)] text-[var(--accent-text)]' + (m.pending ? ' opacity-60' : '')
                : 'bg-[var(--bg-sunken)] text-[var(--ink-secondary)]'
            }`}>
              {m.role === 'assistant' ? <AssistantTurn text={m.text} /> : (
                <span className="whitespace-pre-wrap break-words">{m.text}</span>
              )}
              {m.role === 'user' && (
                <button
                  type="button"
                  onClick={() => onResend(m.text)}
                  title="Resend this instruction as a new run on the same project"
                  className="mt-1 inline-flex items-center gap-1 text-3xs text-[var(--accent-text)] opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
                >
                  <RotateCw size={9} /> Resend
                </button>
              )}
            </div>
          </div>
        ))}
        {streamingText != null && streamingText !== '' && (
          <div className="flex justify-start">
            <div className="max-w-[80%] rounded-xl bg-[var(--bg-sunken)] px-3 py-2 text-ui-xs text-[var(--ink-secondary)]">
              <span className="whitespace-pre-wrap break-words font-mono">{streamingText}</span>
              <span className="ml-0.5 inline-block h-3 w-1.5 animate-pulse bg-[var(--accent-text)] align-text-bottom" aria-hidden />
            </div>
          </div>
        )}
        {busy && (
          <div className="flex justify-start">
            <div className="rounded-xl bg-[var(--bg-sunken)] px-3 py-2 text-ui-xs text-[var(--ink-muted)] flex items-center gap-2">
              <Loader2 size={11} className="animate-spin" /> Sending…
            </div>
          </div>
        )}
      </div>
      <div className="border-t border-[var(--border-subtle)] p-3 shrink-0">
        {inspectTarget && onClearInspect && (
          <>
            <EditingElementChip target={inspectTarget} onClear={onClearInspect} />
            {onVisualEdit && (
              <div className="mb-2 flex flex-wrap items-center gap-1.5">
                <select
                  value={editKind}
                  onChange={(e) => setEditKind(e.target.value as typeof editKind)}
                  className="rounded-md border border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-1.5 py-1 text-3xs"
                >
                  <option value="text">Text</option>
                  <option value="color">Color</option>
                  <option value="spacing">Spacing</option>
                </select>
                <input
                  value={editValue}
                  onChange={(e) => setEditValue(e.target.value)}
                  placeholder={editKind === 'color' ? '#333 or blue' : editKind === 'spacing' ? 'p-4 or 1rem' : 'New text'}
                  className={`${textareaCls} min-h-0 flex-1 py-1 text-2xs`}
                />
                <button
                  type="button"
                  className={btnOutline}
                  disabled={!editValue.trim() || busy}
                  onClick={() => { void onVisualEdit(editKind, editValue.trim()) }}
                >
                  Apply
                </button>
              </div>
            )}
          </>
        )}
        <div className="flex items-end gap-2">
          <textarea
            ref={composerRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit() } }}
            placeholder={inspectTarget ? 'Describe the change for this element…' : 'Tell the builder what to change…'}
            rows={1}
            className={`${textareaCls} min-h-[40px] max-h-32 flex-1 resize-none py-2.5`}
          />
          <button
            type="button"
            onClick={submit}
            disabled={busy || !text.trim()}
            className="mb-0.5 inline-flex items-center gap-1.5 rounded-lg bg-[var(--accent-fill)] px-3 py-2 text-ui-xs font-medium text-white hover:bg-[var(--accent-fill-hover)] disabled:opacity-50 transition"
          >
            <Send size={12} /> Send
          </button>
        </div>
      </div>
    </div>
  )
}

function cellText(value: unknown): string {
  if (value == null) return ''
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value)
  try { return JSON.stringify(value) } catch { return '' }
}

function rowCells(row: unknown, columns: string[]): string[] {
  if (Array.isArray(row)) return columns.map((_, index) => cellText(row[index]))
  if (row && typeof row === 'object') {
    const record = row as Record<string, unknown>
    return columns.map((column) => cellText(record[column]))
  }
  return columns.map(() => cellText(row))
}

function DatabaseRows({
  table,
  columns,
  rows,
  note,
}: {
  table: string | null
  columns: string[]
  rows: unknown[]
  note?: string
}) {
  const headers = columns.length > 0
    ? columns
    : rows[0] && typeof rows[0] === 'object' && !Array.isArray(rows[0])
      ? Object.keys(rows[0] as object)
      : []
  return (
    <div className="rounded-lg border border-[var(--border-subtle)] p-2 text-2xs">
      <p className="font-medium text-[var(--ink-primary)]">{table}</p>
      {note && <p className="mt-1 text-[var(--ink-muted)]">{note}</p>}
      {rows.length === 0 && <p className="mt-1 text-[var(--ink-muted)]">No rows.</p>}
      {rows.length > 0 && headers.length > 0 && (
        <div className="mt-2 overflow-auto">
          <table className="w-full border-collapse text-left">
            <thead>
              <tr>
                {headers.map((column) => (
                  <th key={column} className="border-b border-[var(--border-subtle)] px-2 py-1 font-medium text-[var(--ink-muted)]">{column}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                <tr key={index}>
                  {rowCells(row, headers).map((cell, cellIndex) => (
                    <td key={`${index}-${cellIndex}`} className="border-b border-[var(--border-subtle)] px-2 py-1 align-top text-[var(--ink-secondary)]">{cell || '—'}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function DatabasePanel({ projectId }: { projectId: string | null }) {
  const [tables, setTables] = useState<Array<{ name: string; schema?: string; rls?: boolean }>>([])
  const [meta, setMeta] = useState<{ schema?: string; storage_prefix?: string; provider?: string; note?: string }>({})
  const [selected, setSelected] = useState<string | null>(null)
  const [browse, setBrowse] = useState<{ columns: string[]; rows: unknown[]; note?: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!projectId) return
    setLoading(true)
    void getProjectDatabase(projectId)
      .then((body) => {
        setTables(body.tables ?? [])
        setMeta({ schema: body.schema, storage_prefix: body.storage_prefix, provider: body.provider })
        setError(null)
      })
      .catch((cause) => setError(toUserFacingError(cause).message))
      .finally(() => setLoading(false))
  }, [projectId])

  useEffect(() => {
    if (!projectId || !selected) { setBrowse(null); return }
    void getProjectDatabaseTable(projectId, selected)
      .then((body) => setBrowse({ columns: body.columns, rows: body.rows, note: body.note }))
      .catch((cause) => setError(toUserFacingError(cause).message))
  }, [projectId, selected])

  if (!projectId) return <p className="p-3 text-2xs text-[var(--ink-muted)]">No project yet.</p>
  return (
    <div className="flex flex-1 min-h-0 flex-col p-3 gap-2 overflow-auto">
      {loading && <p className="text-2xs text-[var(--ink-muted)]">Loading schema…</p>}
      {error && <p className="text-2xs text-[var(--danger)]">{error}</p>}
      <p className="text-3xs text-[var(--ink-muted)]">
        {meta.schema ? `Schema ${meta.schema}` : 'Database'}
        {meta.provider ? ` · ${meta.provider}` : ''}
        {meta.storage_prefix ? ` · storage ${meta.storage_prefix}` : ''}
      </p>
      {!tables.length && !loading && (
        <EmptyState title="No tables yet" body="Approve a provision gate during a build to create RLS-backed tables." />
      )}
      <div className="flex flex-wrap gap-1.5">
        {tables.map((table) => (
          <button
            key={table.name}
            type="button"
            className={`${selected === table.name ? btnPrimary : btnGhost} text-2xs`}
            onClick={() => setSelected(table.name)}
          >
            {table.name}{table.rls ? ' · RLS' : ''}
          </button>
        ))}
      </div>
      {browse && (
        <DatabaseRows table={selected} columns={browse.columns} rows={browse.rows} note={browse.note} />
      )}
    </div>
  )
}
