'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { Badge, EmptyState, LoadingState, SectionHeader, StatusDot, btnGhost, btnOutline, btnPrimary, panelCls } from '@loop/ui'
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
  type StreamEvent,
  type TaskNodeView,
} from '@loop/loopit-client'
import { useToast } from '../../lib/toast'
import { AppPage } from '../../components/AppPage'
import { CheckpointDialog, type CheckpointAction } from '../confirm'
import { useBuildRun, useCheckpointAction, useFileContent, useGateDecision, usePreviewUrl, useRunStream } from '../hooks'
import { ErrorNotice } from '../shell'
import { formatWhen, gateTitle, isLiveStatus, statusLabel, statusTone } from '../status'

/** Scripts only. allow-same-origin is omitted so the preview cannot read the app. */
const PREVIEW_SANDBOX = 'allow-scripts'

const BACK = { href: '/build', label: 'All builds' }

export default function RunView({ runId: runIdProp }: { runId?: string }) {
  const params = useParams()
  const raw = runIdProp ?? params?.runId
  const runId = typeof raw === 'string' ? raw : ''
  const query = useBuildRun(runId)
  const toast = useToast()
  const [ui, setUi] = useState(emptyRunUiState)
  const [showCompleted, setShowCompleted] = useState(false)
  const [action, setAction] = useState<CheckpointAction | null>(null)
  const [deployUrl, setDeployUrl] = useState<string | null>(null)
  const [previewPath, setPreviewPath] = useState<string | null>(null)

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

  const onStream = useCallback((event: StreamEvent) => {
    setUi((prev) => reduceRunEvent(prev, event))
    if (event.kind === 'run') {
      const next = pickPreviewFile(event.files)
      if (next) setPreviewPath((current) => current ?? next)
    }
  }, [])

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

  return (
    <AppPage
      width="wide"
      back={BACK}
      title={title}
      documentTitle="Build"
      meta={(
        <>
          {status && <Badge tone={statusTone(status)}>{statusLabel(status)}</Badge>}
          {live && <StatusDot state="working" />}
          {startedAt && <span>Created {formatWhen(startedAt)}</span>}
        </>
      )}
      actions={(
        <button
          type="button"
          className={btnPrimary}
          disabled={!verified || checkpointMutation.isPending}
          onClick={() => verified && setAction({ kind: 'deploy', checkpoint: verified })}
        >
          Publish
        </button>
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
        <div className="mt-6 grid gap-4 lg:grid-cols-[22rem_minmax(0,1fr)]">
          <div className="space-y-4 min-w-0">
            <TaskGraph dagGoal={ui.dag?.goal ?? null} nodes={nodes} showCompleted={showCompleted} onToggle={() => setShowCompleted((value) => !value)} />
            <CheckpointList checkpoints={ui.checkpoints} onAction={setAction} />
            <ActivityList
              activity={ui.activity}
              running={live}
              outcome={status ? {
                status,
                summary: ui.run?.summary ?? null,
                iterations: ui.cost?.iterations,
                credits: ui.cost?.credits_spent,
              } : null}
            />
          </div>
          <Preview
            runId={runId}
            files={ui.run?.files ?? []}
            selected={previewPath}
            onSelect={setPreviewPath}
            url={preview.data ?? null}
            loading={preview.isFetching}
            error={preview.isError ? toUserFacingError(preview.error).message : null}
          />
        </div>
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

function ActivityList({ activity, running, outcome }: { activity: Activity[]; running: boolean; outcome: { status: string; summary: string | null; iterations?: number; credits?: number } | null }) {
  return (
    <section className={`${panelCls} p-4`}>
      <SectionHeader title="Progress" />
      {outcome && !running && (
        <div className={`mt-3 rounded-lg border p-3 ${outcome.status === 'verified' ? 'border-[var(--success-border,var(--border-strong))] bg-[var(--bg-tint)]' : 'border-[var(--border-subtle)] bg-[var(--bg-sunken)]'}`}>
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={statusTone(outcome.status)}>{statusLabel(outcome.status)}</Badge>
            {outcome.iterations != null && <span className="text-3xs text-[var(--ink-muted)]">{outcome.iterations} iteration{outcome.iterations === 1 ? '' : 's'}</span>}
          </div>
          {outcome.summary && <p className="mt-1.5 text-ui-xs text-[var(--ink-secondary)]">{outcome.summary}</p>}
        </div>
      )}
      {!activity.length && !running && !outcome && <EmptyState title="Nothing to report yet" body="Updates appear here while the builder works." />}
      <div className="mt-3 max-h-80 space-y-2 overflow-auto">
        {activity.map((item) => (
          <article key={item.id} className="border-l-2 border-[var(--border-strong)] pl-3">
            <div className="flex items-baseline justify-between gap-2">
              <strong className="text-ui-sm font-medium text-[var(--ink-primary)]">{item.title}</strong>
              <span className="text-3xs text-[var(--ink-muted)]">{item.at}</span>
            </div>
            {item.body && <p className="mt-0.5 break-words text-ui-xs text-[var(--ink-muted)]">{item.body}</p>}
          </article>
        ))}
        {running && <LoadingState label="Waiting for the next update…" className="py-1" />}
      </div>
    </section>
  )
}

function Preview({
  runId, files, selected, onSelect, url, loading, error,
}: {
  runId: string
  files: string[]
  selected: string | null
  onSelect: (path: string) => void
  url: string | null
  loading: boolean
  error: string | null
}) {
  const isHtml = !!selected && /\.html?$/i.test(selected)
  const fileQuery = useFileContent(runId, selected && !isHtml ? selected : null)
  return (
    <section className={`${panelCls} p-4 min-w-0`}>
      <SectionHeader title="Preview" />
      {!!files.length && (
        <div className="mt-3 flex flex-wrap gap-2" role="group" aria-label="Preview file">
          {files.map((path) => (
            <button
              key={path}
              type="button"
              aria-pressed={path === selected}
              title={path}
              className={`${path === selected ? btnPrimary : btnGhost} max-w-full`}
              onClick={() => onSelect(path)}
            >
              <span className="truncate">{path}</span>
            </button>
          ))}
        </div>
      )}
      {!files.length && <EmptyState title="No preview yet" body="The first page appears here once it is ready." />}
      {selected && !isHtml && (
        <div className="mt-3">
          <p className="text-2xs uppercase tracking-wide text-[var(--ink-muted)]">{selected} — read-only</p>
          {fileQuery.isPending && <LoadingState label="Reading file…" />}
          {fileQuery.isError && <p className="mt-2 text-ui-xs text-[var(--danger)]">{toUserFacingError(fileQuery.error).message}</p>}
          {fileQuery.data != null && (
            <pre className="mt-2 max-h-[70vh] overflow-auto rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-4 text-ui-xs leading-relaxed text-[var(--ink-secondary)] whitespace-pre-wrap break-words">{fileQuery.data}</pre>
          )}
        </div>
      )}
      {error && <p className="mt-3 text-ui-sm text-[var(--danger)]" role="alert">{error}</p>}
      {loading && isHtml && <LoadingState label="Loading preview…" />}
      {isHtml && url && (
        <iframe
          title="Build preview"
          sandbox={PREVIEW_SANDBOX}
          referrerPolicy="no-referrer"
          src={url}
          className="mt-3 h-[70vh] w-full rounded-xl border border-[var(--border-subtle)] bg-white"
        />
      )}
    </section>
  )
}
