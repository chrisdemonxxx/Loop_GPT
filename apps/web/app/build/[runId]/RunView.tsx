'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Badge, EmptyState, SectionHeader, Skeleton, StatusDot, btnGhost, btnPrimary } from '@loop/ui'
import {
  ApiError,
  approveGate,
  deployProject,
  emptyRunUiState,
  extractCost,
  extractDag,
  extractGates,
  forkCheckpoint,
  formatTokens,
  isCompletedNode,
  isServiceMissing,
  isUnreachable,
  orderedDagNodes,
  pickPreviewFile,
  reduceRunEvent,
  rejectGate,
  rollbackCheckpoint,
  toUserFacingError,
  type ApprovalGate,
  type CheckpointView,
  type StreamEvent,
  type TaskNodeView,
} from '@loop/loopit-client'
import { useToast } from '../../lib/toast'
import { CheckpointDialog, type CheckpointAction } from '../confirm'
import { useBuildRun, usePreviewUrl, useRunStream } from '../hooks'
import { BuildShell, ErrorNotice } from '../shell'

/** Scripts only. allow-same-origin is omitted so the preview cannot read the app. */
const PREVIEW_SANDBOX = 'allow-scripts'

export default function RunView({ runId: runIdProp }: { runId?: string }) {
  const params = useParams()
  const raw = runIdProp ?? params.runId
  const runId = typeof raw === 'string' ? raw : ''
  const query = useBuildRun(runId)
  const queryClient = useQueryClient()
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
  useRunStream(runId, status === 'running', onStream)

  const projectId = ui.run?.project_id ?? query.data?.project_id ?? null
  const preview = usePreviewUrl(projectId, previewPath && /\.html?$/i.test(previewPath) ? previewPath : null)
  const nodes = useMemo(() => (ui.dag ? orderedDagNodes(ui.dag) : []), [ui.dag])
  const verified = ui.checkpoints.find((checkpoint) => checkpoint.live && checkpoint.verified)
    ?? ui.checkpoints.find((checkpoint) => checkpoint.verified)
    ?? null

  const checkpointMutation = useMutation({
    mutationFn: async ({ pending, reason }: { pending: CheckpointAction; reason: string }) => {
      if (!projectId) throw new Error('This build has no project yet')
      if (pending.kind === 'deploy') return deployProject(projectId, pending.checkpoint.checkpoint_id, reason)
      if (pending.kind === 'rollback') {
        await rollbackCheckpoint(projectId, pending.checkpoint.checkpoint_id)
        return null
      }
      return forkCheckpoint(projectId, pending.checkpoint.checkpoint_id)
    },
    onSuccess: (result) => {
      if (result && 'production_url' in result && result.production_url) {
        setDeployUrl(result.production_url)
        toast.push('success', 'Deployed')
      } else {
        toast.push('success', 'Checkpoint updated')
      }
      setAction(null)
      void queryClient.invalidateQueries({ queryKey: ['loopit-run', runId] })
    },
    onError: (cause) => toast.push('error', toUserFacingError(cause).message),
  })

  const gateMutation = useMutation({
    mutationFn: async ({ gate, approved }: { gate: ApprovalGate; approved: boolean }) => {
      const reason = approved ? 'approved by user in the build page' : 'rejected by user in the build page'
      if (approved) await approveGate(runId, gate.gate_id, reason)
      else await rejectGate(runId, gate.gate_id, reason)
      return gate.gate_id
    },
    onSuccess: (gateId) => {
      setUi((prev) => ({ ...prev, gates: prev.gates.filter((gate) => gate.gate_id !== gateId) }))
      void queryClient.invalidateQueries({ queryKey: ['loopit-run', runId] })
    },
    onError: (cause) => toast.push('error', toUserFacingError(cause).message),
  })

  const closeAction = useCallback(() => setAction(null), [])

  if (!runId || runId === '_') {
    return (
      <BuildShell>
        <EmptyState title="Pick a build" body="Open a build from the board to see its tasks, gates, and preview." action={<Link href="/build" className={btnPrimary}>Back to builds</Link>} />
      </BuildShell>
    )
  }

  const fetchError = query.error
  const offline = fetchError ? isUnreachable(fetchError) || isServiceMissing(fetchError) : false
  const missing = fetchError instanceof ApiError && fetchError.status === 404 && !offline

  return (
    <BuildShell>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <Link href="/build" className="text-xs text-[var(--ink-muted)]">All builds</Link>
          <h1 className="mt-1 text-lg font-semibold break-words">{ui.run?.prompt || query.data?.prompt || 'Build'}</h1>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-[var(--ink-muted)]">
            {status && <Badge tone={statusTone(status)}>{status}</Badge>}
            {status === 'running' && <StatusDot state="working" />}
            {(ui.run?.started_at || query.data?.started_at) && <span>Created {formatWhen((ui.run?.started_at || query.data?.started_at) as string)}</span>}
            {ui.cost && <span>{formatTokens(ui.cost)} tokens</span>}
          </div>
        </div>
        <button
          type="button"
          className={btnPrimary}
          disabled={!verified || checkpointMutation.isPending}
          onClick={() => verified && setAction({ kind: 'deploy', checkpoint: verified })}
        >
          Deploy
        </button>
      </div>

      {query.isPending && (
        <div className="mt-6" role="status" aria-label="Loading build">
          <Skeleton variant="card" />
        </div>
      )}

      {fetchError && (
        <div className="mt-4">
          <ErrorNotice
            error={offline ? {
              kind: 'unavailable',
              title: 'Build service unreachable',
              message: 'The build API is not reachable. It may not be deployed yet.',
              action: 'Retry in a moment.',
            } : missing ? {
              kind: 'unknown',
              title: 'Build not found',
              message: 'This build does not exist, or you do not have access to it.',
              action: 'Return to the build list.',
            } : toUserFacingError(fetchError)}
            onRetry={() => { void query.refetch() }}
          />
        </div>
      )}

      {ui.error && (
        <div className="mt-4">
          <ErrorNotice error={toUserFacingError(new Error(ui.error))} onRetry={() => setUi((prev) => ({ ...prev, error: null }))} />
        </div>
      )}

      {deployUrl && (
        <p className="mt-4 text-sm" role="status">
          Live URL: <a className="text-[var(--accent-text)] underline" href={deployUrl}>{deployUrl}</a>
        </p>
      )}

      <GateList gates={ui.gates} busy={gateMutation.isPending} onDecision={(gate, approved) => gateMutation.mutate({ gate, approved })} />

      {!query.isPending && !fetchError && (
        <div className="mt-6 grid gap-4 lg:grid-cols-[22rem_minmax(0,1fr)]">
          <div className="space-y-4">
            <TaskGraph dagGoal={ui.dag?.goal ?? null} nodes={nodes} showCompleted={showCompleted} onToggle={() => setShowCompleted((value) => !value)} />
            <CheckpointList checkpoints={ui.checkpoints} onAction={setAction} />
            <ActivityList activity={ui.activity} running={status === 'running'} />
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
        onConfirm={(reason) => { if (action) checkpointMutation.mutate({ pending: action, reason }) }}
      />
    </BuildShell>
  )
}

function GateList({ gates, busy, onDecision }: { gates: ApprovalGate[]; busy: boolean; onDecision: (gate: ApprovalGate, approved: boolean) => void }) {
  if (!gates.length) return null
  return (
    <section className="mt-4 space-y-3" aria-label="Approval gates">
      {gates.map((gate) => (
        <article key={gate.gate_id} className="rounded-xl border border-[var(--border-strong)] bg-[var(--bg-panel)] p-4">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-semibold">Approval needed</h2>
            <Badge tone="rose">Needs a person</Badge>
            {gate.destructive && <Badge tone="rose">Destructive</Badge>}
          </div>
          <p className="mt-2 text-sm">{gate.action}</p>
          <p className="mt-1 text-sm text-[var(--ink-secondary)]">{gate.reason}</p>
          {gate.args && (
            <pre className="mt-3 overflow-auto rounded-lg bg-[var(--bg-sunken)] p-3 text-xs text-[var(--ink-secondary)]">{JSON.stringify(gate.args, null, 2)}</pre>
          )}
          <div className="mt-3 flex gap-2">
            <button type="button" className={btnGhost} disabled={busy} onClick={() => onDecision(gate, false)}>Deny</button>
            <button type="button" className={btnPrimary} disabled={busy} onClick={() => onDecision(gate, true)}>Approve</button>
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
    <section className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-panel)] p-4">
      <SectionHeader
        title="Tasks"
        count={nodes.length}
        action={completed.length > 0 ? (
          <button type="button" className={btnGhost} onClick={onToggle}>{showCompleted ? 'Hide completed' : `Show ${completed.length} completed`}</button>
        ) : undefined}
      />
      {!nodes.length && <EmptyState title="No task graph yet" body="Tasks appear here once the planner publishes a graph." />}
      {dagGoal && <p className="mt-2 text-sm text-[var(--ink-secondary)]">{dagGoal}</p>}
      <div className="mt-3 space-y-2">
        {visible.map((node) => (
          <article key={node.id} className="rounded-lg border border-[var(--border-subtle)] p-3">
            <div className="flex flex-wrap items-center gap-2">
              <strong className="text-sm">{node.id}</strong>
              <Badge tone={statusTone(node.status ?? 'pending')}>{node.status ?? 'pending'}</Badge>
              {node.destructive && <Badge tone="rose">Destructive</Badge>}
            </div>
            <p className="mt-1 text-sm text-[var(--ink-secondary)]">{node.goal}</p>
            <p className="mt-1 text-xs text-[var(--ink-muted)]">
              Parents: {node.dag_parents.length ? node.dag_parents.join(', ') : 'base checkpoint'}
            </p>
            {node.destructive_reason && <p className="mt-1 text-xs text-[var(--ink-muted)]">{node.destructive_reason}</p>}
          </article>
        ))}
      </div>
    </section>
  )
}

function CheckpointList({ checkpoints, onAction }: { checkpoints: CheckpointView[]; onAction: (action: CheckpointAction) => void }) {
  return (
    <section className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-panel)] p-4">
      <SectionHeader title="Checkpoints" count={checkpoints.length} />
      {!checkpoints.length && <EmptyState title="No checkpoints yet" body="A green checkpoint can be deployed." />}
      <div className="mt-3 space-y-3">
        {checkpoints.map((checkpoint) => (
          <article key={checkpoint.checkpoint_id} className="rounded-lg border border-[var(--border-subtle)] p-3">
            <div className="flex flex-wrap items-center gap-2">
              <strong className="text-sm">{checkpoint.label ?? checkpoint.checkpoint_id}</strong>
              {checkpoint.live && <Badge tone="green">Live</Badge>}
              {checkpoint.verified && <Badge tone="green">Verified</Badge>}
            </div>
            <p className="mt-1 text-xs text-[var(--ink-muted)]">
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
    <section className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-panel)] p-4">
      <SectionHeader title="Activity" />
      {!activity.length && !running && <EmptyState title="No activity yet" body="Tool calls and verification results stream here." />}
      <div className="mt-3 max-h-80 space-y-2 overflow-auto">
        {activity.map((item) => (
          <article key={item.id} className="border-l-2 border-[var(--border-strong)] pl-3">
            <div className="flex items-baseline justify-between gap-2">
              <strong className="text-sm">{item.title}</strong>
              <span className="text-[10px] text-[var(--ink-muted)]">{item.at}</span>
            </div>
            <p className="text-[10px] text-[var(--ink-muted)]">{item.rawType}</p>
            {item.body && <pre className="mt-1 whitespace-pre-wrap text-xs text-[var(--ink-secondary)]">{item.body.slice(0, 1200)}</pre>}
          </article>
        ))}
        {running && <p className="text-xs text-[var(--ink-muted)]" role="status">Waiting for the next update…</p>}
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
    <section className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-panel)] p-4 min-w-0">
      <SectionHeader title="Preview" />
      {!!files.length && (
        <div className="mt-3 flex flex-wrap gap-2">
          {files.map((path) => (
            <button key={path} type="button" className={path === selected ? btnPrimary : btnGhost} onClick={() => onSelect(path)}>
              {path}
            </button>
          ))}
        </div>
      )}
      {!files.length && <EmptyState title="No preview yet" body="The first verified page opens here." />}
      {selected && !/\.html?$/i.test(selected) && (
        <p className="mt-3 text-xs text-[var(--ink-muted)]">Preview runs HTML pages. This file is not a page.</p>
      )}
      {error && <p className="mt-3 text-sm text-[var(--danger)]" role="alert">{error}</p>}
      {loading && <p className="mt-3 text-xs text-[var(--ink-muted)]" role="status">Loading preview…</p>}
      {url && (
        <iframe
          title="Build preview"
          sandbox={PREVIEW_SANDBOX}
          referrerPolicy="no-referrer"
          src={url}
          className="mt-3 h-[28rem] w-full rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-sunken)]"
        />
      )}
    </section>
  )
}

function formatWhen(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleString()
}

function statusTone(status: string): 'neutral' | 'accent' | 'green' | 'amber' | 'rose' {
  const value = status.toLowerCase()
  if (value === 'verified' || value === 'merged' || value === 'completed' || value === 'success') return 'green'
  if (value === 'error' || value === 'failed') return 'rose'
  if (value === 'running' || value === 'verifying') return 'accent'
  if (value === 'blocked' || value === 'pending') return 'amber'
  return 'neutral'
}
