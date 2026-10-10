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
  formatTokens,
  isCompletedNode,
  isServiceMissing,
  isUnreachable,
  orderedDagNodes,
  pickPreviewFile,
  reduceRunEvent,
  toUserFacingError,
  type ApprovalGate,
  type CheckpointView,
  type StreamEvent,
  type TaskNodeView,
} from '@loop/loopit-client'
import { useToast } from '../../lib/toast'
import { AppPage } from '../../components/AppPage'
import { CheckpointDialog, type CheckpointAction } from '../confirm'
import { useBuildRun, useCheckpointAction, useGateDecision, usePreviewUrl, useRunStream } from '../hooks'
import { ErrorNotice } from '../shell'
import { formatWhen, isLiveStatus, statusLabel, statusTone } from '../status'

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
  useRunStream(runId, live, onStream)

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
          toast.push('success', 'Deployed')
        } else {
          toast.push('success', 'Checkpoint updated')
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
        <EmptyState title="Pick a build" body="Open a build from the board to see its tasks, gates, and preview." action={<Link href="/build" className={btnPrimary}>Back to builds</Link>} />
      </AppPage>
    )
  }

  const fetchError = query.error
  const offline = fetchError ? isUnreachable(fetchError) || isServiceMissing(fetchError) : false
  const missing = fetchError instanceof ApiError && fetchError.status === 404 && !offline
  const title = ui.run?.prompt || query.data?.prompt || 'Build'
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
          {ui.cost && <span>{formatTokens(ui.cost)} tokens</span>}
        </>
      )}
      actions={(
        <button
          type="button"
          className={btnPrimary}
          disabled={!verified || checkpointMutation.isPending}
          onClick={() => verified && setAction({ kind: 'deploy', checkpoint: verified })}
        >
          Deploy
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
        <p className="mt-4 text-ui-sm text-[var(--ink-secondary)]" role="status">
          Live URL: <a className="text-[var(--accent-text)] underline" href={deployUrl}>{deployUrl}</a>
        </p>
      )}

      <GateList gates={ui.gates} busy={gateMutation.isPending} onDecision={decideGate} />

      {!query.isPending && !fetchError && (
        <div className="mt-6 grid gap-4 lg:grid-cols-[22rem_minmax(0,1fr)]">
          <div className="space-y-4 min-w-0">
            <TaskGraph dagGoal={ui.dag?.goal ?? null} nodes={nodes} showCompleted={showCompleted} onToggle={() => setShowCompleted((value) => !value)} />
            <CheckpointList checkpoints={ui.checkpoints} onAction={setAction} />
            <ActivityList activity={ui.activity} running={live} />
          </div>
          <Preview
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
        onCancel={closeAction}
        onConfirm={(reason) => { if (action) runCheckpoint(action, reason) }}
      />
    </AppPage>
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
            {gate.destructive && <Badge tone="rose">Destructive</Badge>}
          </div>
          <p className="mt-2 text-ui-sm text-[var(--ink-primary)]">{gate.action}</p>
          <p className="mt-1 text-ui-sm text-[var(--ink-secondary)]">{gate.reason}</p>
          {gate.args && (
            <pre className="mt-3 overflow-auto rounded-lg bg-[var(--bg-sunken)] p-3 text-ui-xs text-[var(--ink-secondary)]">{JSON.stringify(gate.args, null, 2)}</pre>
          )}
          <div className="mt-3 flex gap-2">
            <button type="button" className={`${btnPrimary} flex-1 sm:flex-none`} disabled={busy} onClick={() => onDecision(gate, true)}>Approve</button>
            <button type="button" className={`${btnOutline} flex-1 sm:flex-none`} disabled={busy} onClick={() => onDecision(gate, false)}>Deny</button>
          </div>
        </article>
      ))}
    </section>
  )
}

function TaskGraph({ dagGoal, nodes, showCompleted, onToggle }: { dagGoal: string | null; nodes: TaskNodeView[]; showCompleted: boolean; onToggle: () => void }) {
  const completed = nodes.filter(isCompletedNode)
  const visible = showCompleted ? nodes : nodes.filter((node) => !isCompletedNode(node))
  return (
    <section className={`${panelCls} p-4`}>
      <SectionHeader
        title="Tasks"
        count={nodes.length}
        action={completed.length > 0 ? (
          <button type="button" className={btnGhost} onClick={onToggle}>{showCompleted ? 'Hide completed' : `Show ${completed.length} completed`}</button>
        ) : undefined}
      />
      {!nodes.length && <EmptyState title="No task graph yet" body="Tasks appear here once the planner publishes a graph." />}
      {dagGoal && <p className="mt-2 text-ui-sm text-[var(--ink-secondary)]">{dagGoal}</p>}
      <div className="mt-3 space-y-2">
        {visible.map((node) => (
          <article key={node.id} className="rounded-lg border border-[var(--border-subtle)] p-3">
            <div className="flex flex-wrap items-center gap-2">
              <strong className="text-ui-sm font-medium text-[var(--ink-primary)] break-all">{node.id}</strong>
              <Badge tone={statusTone(node.status ?? 'pending')}>{statusLabel(node.status ?? 'pending')}</Badge>
              {node.destructive && <Badge tone="rose">Destructive</Badge>}
            </div>
            <p className="mt-1 text-ui-sm text-[var(--ink-secondary)]">{node.goal}</p>
            <p className="mt-1 text-ui-xs text-[var(--ink-muted)]">
              Parents: {node.dag_parents.length ? node.dag_parents.join(', ') : 'base checkpoint'}
            </p>
            {node.destructive_reason && <p className="mt-1 text-ui-xs text-[var(--ink-muted)]">{node.destructive_reason}</p>}
          </article>
        ))}
      </div>
    </section>
  )
}

function CheckpointList({ checkpoints, onAction }: { checkpoints: CheckpointView[]; onAction: (action: CheckpointAction) => void }) {
  return (
    <section className={`${panelCls} p-4`}>
      <SectionHeader title="Checkpoints" count={checkpoints.length} />
      {!checkpoints.length && <EmptyState title="No checkpoints yet" body="A green checkpoint can be deployed." />}
      <div className="mt-3 space-y-3">
        {checkpoints.map((checkpoint) => (
          <article key={checkpoint.checkpoint_id} className="rounded-lg border border-[var(--border-subtle)] p-3">
            <div className="flex flex-wrap items-center gap-2">
              <strong className="text-ui-sm font-medium text-[var(--ink-primary)] break-all">{checkpoint.label ?? checkpoint.checkpoint_id}</strong>
              {checkpoint.live && <Badge tone="green">Live</Badge>}
              {checkpoint.verified && <Badge tone="green">Verified</Badge>}
            </div>
            <p className="mt-1 text-ui-xs text-[var(--ink-muted)]">
              Parent {checkpoint.parent_id ?? 'root'} · {formatWhen(checkpoint.created_at)}
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              <button type="button" className={btnGhost} disabled={!checkpoint.verified} onClick={() => onAction({ kind: 'rollback', checkpoint })}>Roll back</button>
              <button type="button" className={btnGhost} onClick={() => onAction({ kind: 'fork', checkpoint })}>Fork</button>
              <button type="button" className={btnPrimary} disabled={!checkpoint.verified} onClick={() => onAction({ kind: 'deploy', checkpoint })}>Deploy</button>
            </div>
          </article>
        ))}
      </div>
    </section>
  )
}

function ActivityList({ activity, running }: { activity: { id: string; at: string; title: string; body: string; rawType: string; tone: string }[]; running: boolean }) {
  return (
    <section className={`${panelCls} p-4`}>
      <SectionHeader title="Activity" />
      {!activity.length && !running && <EmptyState title="No activity yet" body="Tool calls and verification results stream here." />}
      <div className="mt-3 max-h-80 space-y-2 overflow-auto">
        {activity.map((item) => (
          <article key={item.id} className="border-l-2 border-[var(--border-strong)] pl-3">
            <div className="flex items-baseline justify-between gap-2">
              <strong className="text-ui-sm font-medium text-[var(--ink-primary)]">{item.title}</strong>
              <span className="text-3xs text-[var(--ink-muted)]">{item.at}</span>
            </div>
            <p className="text-3xs text-[var(--ink-muted)]">{item.rawType}</p>
            {item.body && <pre className="mt-1 whitespace-pre-wrap break-words text-ui-xs text-[var(--ink-secondary)]">{item.body.slice(0, 1200)}</pre>}
          </article>
        ))}
        {running && <LoadingState label="Waiting for the next update…" className="py-1" />}
      </div>
    </section>
  )
}

function Preview({
  files, selected, onSelect, url, loading, error,
}: {
  files: string[]
  selected: string | null
  onSelect: (path: string) => void
  url: string | null
  loading: boolean
  error: string | null
}) {
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
      {!files.length && <EmptyState title="No preview yet" body="The first verified page opens here." />}
      {selected && !/\.html?$/i.test(selected) && (
        <p className="mt-3 text-ui-xs text-[var(--ink-muted)]">Preview runs HTML pages. This file is not a page.</p>
      )}
      {error && <p className="mt-3 text-ui-sm text-[var(--danger)]" role="alert">{error}</p>}
      {loading && <LoadingState label="Loading preview…" />}
      {url && (
        <iframe
          title="Build preview"
          sandbox={PREVIEW_SANDBOX}
          referrerPolicy="no-referrer"
          src={url}
          className="mt-3 h-[min(28rem,70dvh)] w-full rounded-xl border border-[var(--border-subtle)] bg-white"
        />
      )}
    </section>
  )
}
