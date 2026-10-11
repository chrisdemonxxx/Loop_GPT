'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import {
  AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, ExternalLink, FileCode2,
  FileText, Loader2, Monitor, Play, Rocket, RotateCw, Send, ShieldCheck, Smartphone, Sparkles, Square, Terminal, X,
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
  runTitle,
  toUserFacingError,
  type Activity,
  type ApprovalGate,
  type CheckpointView,
  type RunSummary,
  type RunTier,
  type StreamEvent,
  type TaskNodeView,
} from '@loop/loopit-client'
import { useToast } from '../../lib/toast'
import { AppPage } from '../../components/AppPage'
import { CheckpointDialog, type CheckpointAction } from '../confirm'
import {
  useBuildRun, useCancelRun, useCheckpointAction, useExecCommand, useFileContent, useGateDecision,
  usePreviewUrl, useRunStream, useSendRunMessage, useStartBuild,
} from '../hooks'
import { ErrorNotice } from '../shell'
import { formatWhen, gateTitle, isLiveStatus, statusLabel, statusTone } from '../status'

/** Scripts only. allow-same-origin is omitted so the preview cannot read the app. */
const PREVIEW_SANDBOX = 'allow-scripts'

const BACK = { href: '/build', label: 'All builds' }

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
  const [previewPath, setPreviewPath] = useState<string | null>(null)
  const [codePath, setCodePath] = useState<string | null>(null)
  const [previewEpoch, setPreviewEpoch] = useState(0)
  const [messages, setMessages] = useState<{ id: string; role: 'user' | 'system'; text: string; at: string }[]>([])
  const [terminalOpen, setTerminalOpen] = useState(false)
  const composerRef = useRef<HTMLTextAreaElement>(null)
  const reloadTimer = useRef<number | null>(null)

  const sendMessage = useSendRunMessage(runId)
  const cancel = useCancelRun(runId)

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

  /** The preview re-renders when the builder touches files — debounced so a
   *  patch storm reloads once, not per patch. */
  const pokePreviewReload = useCallback(() => {
    if (reloadTimer.current) window.clearTimeout(reloadTimer.current)
    reloadTimer.current = window.setTimeout(() => setPreviewEpoch((n) => n + 1), 1500)
  }, [])

  const onStream = useCallback((event: StreamEvent) => {
    setUi((prev) => reduceRunEvent(prev, event))
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
  useRunStream(runId, true, onStream)

  const projectId = ui.run?.project_id ?? query.data?.project_id ?? null
  const preview = usePreviewUrl(projectId, previewPath && /\.html?$/i.test(previewPath) ? previewPath : null)
  const nodes = useMemo(() => (ui.dag ? orderedDagNodes(ui.dag) : []), [ui.dag])
  const verified = ui.checkpoints.find((checkpoint) => checkpoint.live && checkpoint.verified)
    ?? ui.checkpoints.find((checkpoint) => checkpoint.verified)
    ?? null

  const checkpointMutation = useCheckpointAction(runId, projectId)
  const gateMutation = useGateDecision(runId)
  const exec = useExecCommand(projectId)
  const closeAction = useCallback(() => setAction(null), [])

  const runCheckpoint = (pending: CheckpointAction, reason: string) => {
    checkpointMutation.mutate({ pending, reason }, {
      onSuccess: (result) => {
        if (result && 'production_url' in result && result.production_url) {
          setDeployUrl(result.production_url)
          toast.push('success', 'Your app is live')
        } else {
          toast.push('success', 'Version saved')
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

  const handleSendMessage = (text: string) => {
    const trimmed = text.trim()
    if (!trimmed || sendMessage.isPending) return
    setMessages((prev) => [...prev, { id: `${Date.now()}-user`, role: 'user', text: trimmed, at: new Date().toISOString() }])
    sendMessage.mutate(trimmed, {
      onError: (cause) => toast.push('error', toUserFacingError(cause).message),
    })
  }

  const handleCancel = () => {
    if (!live || cancel.isPending) return
    cancel.mutate(undefined, {
      onSuccess: () => toast.push('info', 'Build stopped'),
      onError: (cause) => toast.push('error', toUserFacingError(cause).message),
    })
  }

  const terminalFailed = ['error', 'failed', 'budget_exceeded', 'stalled', 'cancelled', 'canceled'].includes(status?.toLowerCase() ?? '')

  if (!runId || runId === '_') {
    return (
      <AppPage title="Build" back={BACK}>
        <EmptyState title="Pick a build" body="Open a build from the board to see its progress and preview." action={<Link href="/build" className={btnPrimary}>Back to builds</Link>} />
      </AppPage>
    )
  }

  const fetchError = query.error
  const offline = fetchError ? isUnreachable(fetchError) || isServiceMissing(fetchError) : false
  const missing = fetchError instanceof ApiError && fetchError.status === 404 && !offline
  const title = runTitle(ui.run ?? query.data)
  const startedAt = ui.run?.started_at || query.data?.started_at
  const files = ui.run?.files ?? []

  return (
    <AppPage
      width="fill"
      back={BACK}
      title={title}
      documentTitle="Build"
      meta={(
        <>
          {status && <Badge tone={statusTone(status)}>{statusLabel(status)}</Badge>}
          {ui.run?.tier && <Badge tone="neutral">{ui.run.tier}</Badge>}
          {live && <StatusDot state="working" />}
          {startedAt && <Elapsed since={startedAt} live={!!live} />}
          {ui.cost?.credits_spent != null && ui.cost.credits_spent > 0 && (
            <span>{ui.cost.credits_spent.toFixed(3)} credits</span>
          )}
        </>
      )}
      actions={(
        <div className="flex items-center gap-2">
          {live ? (
            <button
              type="button"
              className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--danger-soft-border)] bg-[var(--danger-soft)] px-3 py-1.5 text-ui-xs font-medium text-[var(--danger)] hover:bg-[var(--danger-soft-hover)] transition"
              disabled={cancel.isPending}
              onClick={handleCancel}
            >
              <Square size={11} className="fill-current" /> Stop
            </button>
          ) : terminalFailed ? (
            <>
              <button
                type="button"
                className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--border-strong)] bg-[var(--bg-hover-strong)] px-3 py-1.5 text-ui-xs font-medium text-[var(--ink-secondary)] hover:bg-[var(--bg-hover)] transition"
                onClick={() => { composerRef.current?.focus() }}
              >
                <Play size={12} /> Continue
              </button>
              <RetryButton run={ui.run ?? query.data} />
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
      {query.isPending && <LoadingState variant="card" label="Loading build" />}

      {fetchError && (
        <ErrorNotice
          error={offline ? {
            kind: 'unavailable',
            title: 'Build service unreachable',
            message: 'The Build service is not reachable. It may not be deployed yet.',
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
            <p className="text-ui-sm font-medium text-[var(--accent-text)]">Your app is live</p>
            <p className="mt-0.5 text-ui-xs text-[var(--ink-secondary)]">Anyone with this link can open the app you just published. The link stays valid for 30 days.</p>
          </div>
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
          <a href={deployUrl} target="_blank" rel="noreferrer" className={btnPrimary}>Open app</a>
        </div>
      )}

      <GateList gates={ui.gates} busy={gateMutation.isPending} onDecision={decideGate} />

      {!query.isPending && !fetchError && (
        <>
          {status && <StatusStepper status={status} />}
          <div className="mt-4 grid gap-4 xl:grid-cols-[340px_minmax(0,1fr)]">
            <div className="space-y-4 min-w-0 order-2 xl:order-1">
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
              <CheckpointList checkpoints={ui.checkpoints} onAction={setAction} />
            </div>
            <PreviewWorkspace
              className="order-1 xl:order-2"
              runId={runId}
              files={files}
              selected={previewPath}
              onSelect={(path) => {
                if (/\.html?$/i.test(path)) { setPreviewPath(path); setCodePath(null) }
                else setCodePath(path)
              }}
              codePath={codePath}
              onCloseCode={() => setCodePath(null)}
              url={preview.data ?? null}
              epoch={previewEpoch}
              onReload={() => setPreviewEpoch((n) => n + 1)}
              loading={preview.isFetching}
              error={preview.isError ? toUserFacingError(preview.error).message : null}
              live={!!live}
            />
          </div>
          <RunWorkspace
            runId={runId}
            projectId={projectId}
            messages={messages}
            onSendMessage={handleSendMessage}
            sendBusy={sendMessage.isPending}
            terminalOpen={terminalOpen}
            onToggleTerminal={() => setTerminalOpen((v) => !v)}
            composerRef={composerRef}
          />
        </>
      )}

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

/** Planning → Building → Verifying → Done, as a compact stepper. */
function StatusStepper({ status }: { status: string }) {
  const value = status.toLowerCase()
  const failed = ['error', 'failed', 'budget_exceeded', 'stalled', 'cancelled', 'canceled'].includes(value)
  const stage =
    value === 'planning' ? 0
    : ['verified', 'merged', 'deployed', 'completed', 'success'].includes(value) ? 3
    : ['verifying', 'checkpointing', 'deploying'].includes(value) ? 2
    : 1
  const steps = ['Planning', 'Building', 'Verifying', 'Done']
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

/** Same layout and order as the chat approval card (TurnActivity): Approve first. */
function GateList({ gates, busy, onDecision }: { gates: ApprovalGate[]; busy: boolean; onDecision: (gate: ApprovalGate, approved: boolean) => void }) {
  if (!gates.length) return null
  return (
    <section className="mt-4 space-y-3" aria-label="Approval gates">
      {gates.map((gate) => (
        <article key={gate.gate_id} className="rounded-xl border border-[var(--accent-soft-border)] bg-[var(--accent-soft)] p-4">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-ui-sm font-medium text-[var(--accent-text)]">Approval needed</h2>
            {gate.destructive && <Badge tone="rose">Cannot be undone</Badge>}
          </div>
          <p className="mt-2 text-ui-sm text-[var(--ink-primary)]">{gateTitle(gate.action)}</p>
          {gate.reason && <p className="mt-1 text-ui-sm text-[var(--ink-secondary)]">{gate.reason}</p>}
          {gate.args && (
            <details className="mt-3">
              <summary className="cursor-pointer text-ui-xs text-[var(--ink-muted)] hover:text-[var(--ink-secondary)]">Technical details</summary>
              <pre className="mt-2 overflow-auto rounded-lg bg-[var(--bg-sunken)] p-3 text-ui-xs text-[var(--ink-secondary)]">{JSON.stringify(gate.args, null, 2)}</pre>
            </details>
          )}
          <div className="mt-3 flex gap-2">
            <button type="button" className={`${btnPrimary} flex-1 sm:flex-none`} disabled={busy} onClick={() => onDecision(gate, true)}>Approve</button>
            <button type="button" className={`${btnOutline} flex-1 sm:flex-none`} disabled={busy} onClick={() => onDecision(gate, false)}>Decline</button>
          </div>
        </article>
      ))}
    </section>
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

function CheckpointList({ checkpoints, onAction }: { checkpoints: CheckpointView[]; onAction: (action: CheckpointAction) => void }) {
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
              <button type="button" className={btnGhost} disabled={!checkpoint.verified} onClick={() => onAction({ kind: 'rollback', checkpoint })}>Roll back here</button>
              <button type="button" className={btnGhost} onClick={() => onAction({ kind: 'fork', checkpoint })}>Save a copy</button>
              <button type="button" className={btnPrimary} disabled={!checkpoint.verified} onClick={() => onAction({ kind: 'deploy', checkpoint })}>Publish</button>
            </div>
          </article>
        ))}
      </div>
    </section>
  )
}

/** Classify an activity row for its timeline icon, from the event's words. */
function activityIcon(item: Activity): { Icon: typeof FileText; cls: string } {
  const text = `${item.title} ${item.body ?? ''}`.toLowerCase()
  if (/fail|error|reject|stall|denied|crash/.test(text)) return { Icon: AlertTriangle, cls: 'text-[var(--danger)]' }
  if (/verif|check|test|lint|typecheck|smoke/.test(text)) return { Icon: ShieldCheck, cls: 'text-[var(--success)]' }
  if (/patch|created|modified|wrote|applied|edit/.test(text)) return { Icon: FileCode2, cls: 'text-[var(--accent-text)]' }
  if (/read|search|scan|look/.test(text)) return { Icon: FileText, cls: 'text-[var(--ink-muted)]' }
  if (/model|think|brief|plan/.test(text)) return { Icon: Sparkles, cls: 'text-[var(--accent-text)]' }
  if (/deploy|publish|live/.test(text)) return { Icon: Rocket, cls: 'text-[var(--success)]' }
  return { Icon: ChevronRight, cls: 'text-[var(--ink-muted)]' }
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
                  <span className="text-3xs text-[var(--ink-muted)] shrink-0">{item.at}</span>
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
  runId, files, selected, onSelect, codePath, onCloseCode, url, epoch, onReload, loading, error, live, className = '',
}: {
  runId: string
  files: string[]
  selected: string | null
  onSelect: (path: string) => void
  codePath: string | null
  onCloseCode: () => void
  url: string | null
  epoch: number
  onReload: () => void
  loading: boolean
  error: string | null
  live: boolean
  className?: string
}) {
  const [device, setDevice] = useState<'desktop' | 'mobile'>('desktop')
  const [filesOpen, setFilesOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!filesOpen) return
    const close = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) setFilesOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [filesOpen])

  return (
    <section className={`${panelCls} overflow-hidden flex flex-col min-w-0 min-h-[78vh] ${className}`}>
      {/* Browser chrome */}
      <div className="flex items-center gap-1.5 px-3 py-2 border-b border-[var(--border-subtle)] shrink-0">
        <span className="flex items-center gap-1.5 mr-1 shrink-0" aria-hidden>
          <i className="w-2.5 h-2.5 rounded-full bg-[var(--danger)] opacity-70 block" />
          <i className="w-2.5 h-2.5 rounded-full bg-[var(--warning)] opacity-70 block" />
          <i className="w-2.5 h-2.5 rounded-full bg-[var(--success)] opacity-70 block" />
        </span>
        <div className="flex-1 min-w-0 flex items-center gap-1.5 rounded-lg bg-[var(--bg-sunken)] border border-[var(--border-subtle)] px-2.5 py-1.5 text-ui-xs text-[var(--ink-secondary)]">
          {live ? <Loader2 size={11} className="animate-spin shrink-0 text-[var(--accent-text)]" aria-hidden /> : <Monitor size={11} className="shrink-0" aria-hidden />}
          <span className="truncate font-mono text-2xs">{selected || 'preview'}</span>
        </div>
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
        <button
          type="button"
          onClick={() => setDevice('desktop')}
          aria-pressed={device === 'desktop'}
          title="Desktop width"
          className={`p-1.5 rounded-lg transition shrink-0 ${device === 'desktop' ? 'text-[var(--accent-text)] bg-[var(--accent-soft)]' : 'text-[var(--ink-muted)] hover:bg-[var(--bg-hover)]'}`}
        >
          <Monitor size={13} aria-hidden />
        </button>
        <button
          type="button"
          onClick={() => setDevice('mobile')}
          aria-pressed={device === 'mobile'}
          title="Mobile width"
          className={`p-1.5 rounded-lg transition shrink-0 ${device === 'mobile' ? 'text-[var(--accent-text)] bg-[var(--accent-soft)]' : 'text-[var(--ink-muted)] hover:bg-[var(--bg-hover)]'}`}
        >
          <Smartphone size={13} aria-hidden />
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

      {/* Stage */}
      <div className="relative flex-1 min-h-0 bg-[var(--bg-sunken)] flex justify-center">
        <div className="h-full w-full transition-[max-width] duration-300" style={{ maxWidth: device === 'mobile' ? 390 : undefined }}>
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
              key={`${url}:${epoch}`}
              title="Build preview"
              sandbox={PREVIEW_SANDBOX}
              referrerPolicy="no-referrer"
              src={url}
              className="h-full w-full border-0 bg-white"
            />
          )}
        </div>

        {/* Code drawer (non-HTML files) */}
        {codePath && <CodeDrawer runId={runId} path={codePath} onClose={onCloseCode} />}
      </div>
    </section>
  )
}

/** Start a follow-up run with the same prompt and project, keeping the workspace. */
function RetryButton({ run }: { run: RunSummary | null | undefined }) {
  const router = useRouter()
  const start = useStartBuild()
  if (!run) return null
  return (
    <button
      type="button"
      className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--border-strong)] bg-[var(--bg-hover-strong)] px-3 py-1.5 text-ui-xs font-medium text-[var(--ink-secondary)] hover:bg-[var(--bg-hover)] transition"
      disabled={start.isPending}
      onClick={async () => {
        try {
          const created = await start.mutateAsync({ prompt: run.prompt, tier: run.tier })
          router.push(`/build/?run=${encodeURIComponent(created.run_id)}`)
        } catch { /* error surfaces via start.error */ }
      }}
    >
      <RotateCw size={12} /> Retry
    </button>
  )
}

/** Replit-style bottom workspace: Chat (always-on) and Terminal tabs. */
function RunWorkspace({
  runId, projectId, messages, onSendMessage, sendBusy, terminalOpen, onToggleTerminal, composerRef,
}: {
  runId: string
  projectId: string | null
  messages: { id: string; role: 'user' | 'system'; text: string; at: string }[]
  onSendMessage: (text: string) => void
  sendBusy: boolean
  terminalOpen: boolean
  onToggleTerminal: () => void
  composerRef: React.RefObject<HTMLTextAreaElement | null>
}) {
  return (
    <section className={`${panelCls} mt-4 overflow-hidden flex flex-col`}>
      <div className="flex items-center gap-2 border-b border-[var(--border-subtle)] px-3 py-2 shrink-0">
        <RunWorkspaceTab active={!terminalOpen} onClick={() => { if (terminalOpen) onToggleTerminal() }} icon={Send} label="Chat" />
        <RunWorkspaceTab active={terminalOpen} onClick={() => { if (!terminalOpen) onToggleTerminal() }} icon={Terminal} label="Terminal" />
      </div>
      <div className="min-h-[220px] max-h-[40vh] flex flex-col">
        {terminalOpen ? (
          <RunTerminal projectId={projectId} />
        ) : (
          <RunChat messages={messages} onSend={onSendMessage} busy={sendBusy} composerRef={composerRef} />
        )}
      </div>
    </section>
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

function RunChat({ messages, onSend, busy, composerRef }: {
  messages: { id: string; role: 'user' | 'system'; text: string; at: string }[]
  onSend: (text: string) => void
  busy: boolean
  composerRef: React.RefObject<HTMLTextAreaElement | null>
}) {
  const [text, setText] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages.length])

  const submit = () => {
    if (!text.trim() || busy) return
    onSend(text)
    setText('')
  }

  return (
    <div className="flex flex-1 min-h-0 flex-col">
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-auto p-3 space-y-3">
        {messages.length === 0 && (
          <p className="text-2xs text-[var(--ink-muted)]">Steer the builder while it runs, or continue after it stops.</p>
        )}
        {messages.map((m) => (
          <div key={m.id} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-[80%] rounded-xl px-3 py-2 text-ui-xs ${
              m.role === 'user' ? 'bg-[var(--accent-soft)] text-[var(--accent-text)]' : 'bg-[var(--bg-sunken)] text-[var(--ink-secondary)]'
            }`}>
              {m.text}
            </div>
          </div>
        ))}
        {busy && (
          <div className="flex justify-start">
            <div className="rounded-xl bg-[var(--bg-sunken)] px-3 py-2 text-ui-xs text-[var(--ink-muted)] flex items-center gap-2">
              <Loader2 size={11} className="animate-spin" /> Sending…
            </div>
          </div>
        )}
      </div>
      <div className="border-t border-[var(--border-subtle)] p-3 shrink-0">
        <div className="flex items-end gap-2">
          <textarea
            ref={composerRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit() } }}
            placeholder="Tell the builder what to change…"
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

function RunTerminal({ projectId }: { projectId: string | null }) {
  const exec = useExecCommand(projectId)
  const [command, setCommand] = useState('')
  const [history, setHistory] = useState<{ id: string; command: string; stdout: string; stderr: string; exitCode: number; duration: number }[]>([])
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [history.length, exec.isPending])

  const run = () => {
    const trimmed = command.trim()
    if (!trimmed || exec.isPending || !projectId) return
    setCommand('')
    exec.mutate({ command: trimmed, timeoutSeconds: 60 }, {
      onSuccess: (result) => setHistory((prev) => [...prev, {
        id: `${Date.now()}`,
        command: result.command,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exit_code,
        duration: result.duration_seconds,
      }]),
    })
  }

  return (
    <div className="flex flex-1 min-h-0 flex-col">
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-auto bg-black p-3 font-mono text-2xs">
        {history.length === 0 && <p className="text-[var(--ink-muted)]">Run shell commands in your project workspace. Same machine the builder uses.</p>}
        {history.map((h) => (
          <div key={h.id} className="mb-3">
            <div className="flex items-center gap-2 text-[var(--accent-text)]">
              <span className="text-[var(--success)]">$</span>
              <span>{h.command}</span>
              <span className="ml-auto text-[var(--ink-muted)]">{h.duration.toFixed(2)}s</span>
            </div>
            {h.stdout && <pre className="mt-1 whitespace-pre-wrap text-[var(--ink-secondary)]">{h.stdout}</pre>}
            {h.stderr && <pre className="mt-1 whitespace-pre-wrap text-[var(--danger)]">{h.stderr}</pre>}
            <div className={`mt-1 text-3xs ${h.exitCode === 0 ? 'text-[var(--success)]' : 'text-[var(--danger)]'}`}>exit {h.exitCode}</div>
          </div>
        ))}
        {exec.isPending && <p className="text-[var(--ink-muted)] flex items-center gap-2"><Loader2 size={11} className="animate-spin" /> Running…</p>}
      </div>
      <div className="border-t border-[var(--border-subtle)] p-3 shrink-0 bg-[var(--bg-base)]">
        <div className="flex items-center gap-2">
          <span className="text-[var(--success)] font-mono text-ui-xs">$</span>
          <input
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') run() }}
            placeholder="Type a command and press Enter"
            disabled={exec.isPending}
            className="flex-1 bg-transparent text-ui-xs text-[var(--ink-primary)] placeholder:text-[var(--ink-muted)] focus:outline-none font-mono"
          />
          <button
            type="button"
            onClick={run}
            disabled={exec.isPending || !command.trim()}
            className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--accent-fill)] px-3 py-1.5 text-ui-xs font-medium text-white hover:bg-[var(--accent-fill-hover)] disabled:opacity-50 transition"
          >
            Run
          </button>
        </div>
      </div>
    </div>
  )
}

/** A slide-over code viewer so source files never replace the live preview. */
function CodeDrawer({ runId, path, onClose }: { runId: string; path: string; onClose: () => void }) {
  const fileQuery = useFileContent(runId, path)
  return (
    <div className="absolute inset-y-0 right-0 w-full sm:w-[440px] max-w-full flex flex-col border-l border-[var(--border-subtle)] bg-[var(--bg-base)] shadow-panel">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-[var(--border-subtle)] shrink-0">
        <FileCode2 size={13} className="text-[var(--accent-text)] shrink-0" aria-hidden />
        <span className="flex-1 min-w-0 truncate font-mono text-ui-xs text-[var(--ink-primary)]">{path}</span>
        <button type="button" onClick={onClose} aria-label="Close file" className="p-1 rounded-lg text-[var(--ink-muted)] hover:bg-[var(--bg-hover)] transition">
          <X size={14} aria-hidden />
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-auto">
        {fileQuery.isPending && <LoadingState label="Reading file…" />}
        {fileQuery.isError && <p className="m-3 text-ui-xs text-[var(--danger)]">{toUserFacingError(fileQuery.error).message}</p>}
        {fileQuery.data != null && (
          <pre className="p-4 text-2xs leading-relaxed text-[var(--ink-secondary)] whitespace-pre-wrap break-words font-mono">{fileQuery.data}</pre>
        )}
      </div>
    </div>
  )
}
