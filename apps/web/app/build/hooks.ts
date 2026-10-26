'use client'

import { useEffect, useRef } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  approveGate,
  cancelRun,
  createPreviewUrl,
  deployProject,
  execCommand,
  forkCheckpoint,
  getFile,
  getHealth,
  getMe,
  getRun,
  listProjects,
  listRuns,
  getProject,
  putProjectKnowledge,
  renameProject,
  archiveProject,
  restoreProject,
  duplicateProject,
  getCheckpointFile,
  rejectGate,
  rollbackCheckpoint,
  sendRunMessage,
  startRun,
  streamRunEvents,
  listNotifications,
  markNotificationsRead,
  listReviews,
  applyReview,
  dismissReview,
  toUserFacingError,
  TERMINAL_SCOPE,
  PREVIEW_TTL_SECONDS,
  type ApprovalGate,
  type CheckpointView,
  type PendingReview,
  type PreviewUrl,
  type ProjectDetail,
  type ProjectSummary,
  type RunDetail,
  type RunMode,
  type RunSummary,
  type RunTier,
  type StreamEvent,
} from '@loop/loopit-client'
import { isLiveStatus } from './status'

export function useBuildRuns() {
  const query = useQuery<RunSummary[]>({
    queryKey: ['loopit-runs'],
    queryFn: () => listRuns(),
    enabled: typeof window !== 'undefined',
    retry: false,
    refetchInterval: (q) => {
      const runs = q.state.data
      if (!Array.isArray(runs)) return false
      return runs.some((run) => isLiveStatus(run.status)) ? 4000 : false
    },
  })
  return query
}

export function useBuildRun(runId: string) {
  const enabled = typeof window !== 'undefined' && runId.length > 0 && runId !== '_'
  return useQuery<RunDetail>({
    queryKey: ['loopit-run', runId],
    queryFn: () => getRun(runId),
    enabled,
    retry: false,
    refetchInterval: (q) => (isLiveStatus(q.state.data?.status) ? 3000 : false),
  })
}

/** Engine health — used to hide approval gates in local mode (they cannot resume). */
export function useBuildHealth() {
  return useQuery({
    queryKey: ['loopit-health'],
    queryFn: () => getHealth(),
    enabled: typeof window !== 'undefined',
    retry: false,
    staleTime: 60_000,
  })
}

/** True when gate approve/reject can unblock a run (orchestrator or local resume). */
export function useGatesEnabled(): boolean {
  const health = useBuildHealth()
  const mode = health.data?.run_execution_mode?.toLowerCase()
  // Phase 1.10: local_gates wires ApprovalSignal resume in-process.
  if (health.data?.local_gates) return true
  return mode === 'orchestrator'
}

export function useStartBuild() {
  const queryClient = useQueryClient()
  return useMutation({
    // Phase 3.6: optional Quick/Standard/Deep `tier` maps to the engine budget.
    // Without a tier the brief still sizes effort elastically.
    // A projectId continues that project's workspace; without one the engine
    // starts a new project.
    mutationFn: (input: {
      prompt: string
      projectId?: string | null
      mode?: RunMode
      tier?: RunTier
      attachmentUrls?: string[]
      background?: boolean
      browser?: boolean
      browserDeviceId?: string
      browserGrantId?: string
    }) =>
      startRun(input.prompt, {
        ...(input.projectId ? { projectId: input.projectId } : {}),
        ...(input.mode ? { mode: input.mode } : {}),
        ...(input.tier ? { tier: input.tier } : {}),
        ...(input.attachmentUrls?.length ? { attachmentUrls: input.attachmentUrls } : {}),
        ...(input.background ? { background: true } : {}),
        ...(input.browser ? { browser: true, browserDeviceId: input.browserDeviceId, ...(input.browserGrantId ? { browserGrantId: input.browserGrantId } : {}) } : {}),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['loopit-runs'] })
      queryClient.invalidateQueries({ queryKey: ['loopit-projects'] })
      queryClient.invalidateQueries({ queryKey: ['loopit-notifications'] })
      queryClient.invalidateQueries({ queryKey: ['loopit-reviews'] })
    },
  })
}

/** Phase 2.9 notifications badge (unread background-build reviews). */
export function useBuildNotifications() {
  return useQuery({
    queryKey: ['loopit-notifications'],
    queryFn: () => listNotifications(),
    enabled: typeof window !== 'undefined',
    retry: false,
    refetchInterval: 8_000,
  })
}

export function useMarkNotificationsRead() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (notificationId?: string | null) => markNotificationsRead(notificationId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['loopit-notifications'] })
    },
  })
}

export function usePendingReviews(projectId?: string | null) {
  return useQuery<PendingReview[]>({
    queryKey: ['loopit-reviews', projectId ?? 'all'],
    queryFn: () => listReviews(projectId ? { projectId } : undefined),
    enabled: typeof window !== 'undefined',
    retry: false,
    refetchInterval: 8_000,
  })
}

export function useApplyReview() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (reviewId: string) => applyReview(reviewId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['loopit-reviews'] })
      queryClient.invalidateQueries({ queryKey: ['loopit-notifications'] })
      queryClient.invalidateQueries({ queryKey: ['loopit-runs'] })
      queryClient.invalidateQueries({ queryKey: ['loopit-projects'] })
    },
  })
}

export function useDismissReview() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (reviewId: string) => dismissReview(reviewId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['loopit-reviews'] })
      queryClient.invalidateQueries({ queryKey: ['loopit-notifications'] })
    },
  })
}

export function useBuildProjects(includeArchived = false) {
  return useQuery<ProjectSummary[]>({
    queryKey: ['loopit-projects', includeArchived],
    queryFn: () => listProjects({ includeArchived }),
    enabled: typeof window !== 'undefined',
    retry: false,
  })
}

export function useBuildProject(projectId: string) {
  return useQuery<ProjectDetail>({
    queryKey: ['loopit-project', projectId],
    queryFn: () => getProject(projectId),
    enabled: typeof window !== 'undefined' && projectId.length > 0,
    retry: false,
  })
}

export function useRenameProject() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: { projectId: string; name: string }) => renameProject(input.projectId, input.name),
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({ queryKey: ['loopit-projects'] })
      queryClient.invalidateQueries({ queryKey: ['loopit-project', vars.projectId] })
    },
  })
}

export function useArchiveProject() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (projectId: string) => archiveProject(projectId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['loopit-projects'] }),
  })
}

export function useRestoreProject() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (projectId: string) => restoreProject(projectId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['loopit-projects'] }),
  })
}

export function useDuplicateProject() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (projectId: string) => duplicateProject(projectId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['loopit-projects'] }),
  })
}

export function usePutProjectKnowledge(projectId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (knowledge: string) => putProjectKnowledge(projectId, knowledge),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['loopit-project', projectId] }),
  })
}

export function useCheckpointFile(projectId: string | null, checkpointId: string | null, path: string | null) {
  return useQuery({
    queryKey: ['loopit-checkpoint-file', projectId, checkpointId, path],
    queryFn: () => getCheckpointFile(projectId!, checkpointId!, path!),
    enabled: !!(projectId && checkpointId && path),
    retry: false,
  })
}

export function useSendRunMessage(runId: string) {
  return useMutation({
    mutationFn: (message: string) => sendRunMessage(runId, message),
  })
}

export function useCancelRun(runId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => cancelRun(runId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['loopit-run', runId] }),
  })
}

/** Whether the engine will accept terminal commands from this user. The engine
 *  enforces the scope itself; this only decides whether to show the tab. */
export function useTerminalAccess(): boolean {
  const query = useQuery({
    queryKey: ['loopit-me'],
    queryFn: () => getMe(),
    enabled: typeof window !== 'undefined',
    retry: false,
    staleTime: 5 * 60_000,
  })
  return query.data?.scopes?.includes(TERMINAL_SCOPE) ?? false
}

export function useExecCommand(projectId: string | null) {
  return useMutation({
    mutationFn: (input: { command: string; timeoutSeconds?: number }) => {
      if (!projectId) throw new Error('No project')
      return execCommand(projectId, input.command, input.timeoutSeconds)
    },
  })
}

export type CheckpointAction = { kind: 'deploy' | 'rollback' | 'fork'; checkpoint: CheckpointView }

export type CheckpointActionResult =
  | { kind: 'deploy'; production_url: string; status: string; deployment_id?: string }
  | { kind: 'rollback' }
  | { kind: 'fork'; project_id?: string }

/** Deploy / roll back / fork a checkpoint, then refresh the run. */
export function useCheckpointAction(runId: string, projectId: string | null, options?: { live?: boolean }) {
  const queryClient = useQueryClient()
  const live = options?.live ?? false
  return useMutation({
    mutationFn: async ({ pending, reason }: { pending: CheckpointAction; reason: string }): Promise<CheckpointActionResult> => {
      if (!projectId) throw new Error('This build has no project yet')
      if (pending.kind === 'deploy') {
        const result = await deployProject(projectId, pending.checkpoint.checkpoint_id, reason)
        return { kind: 'deploy', ...result }
      }
      if (pending.kind === 'rollback') {
        if (live) throw new Error('Stop the build before rolling back to an earlier version')
        await rollbackCheckpoint(projectId, pending.checkpoint.checkpoint_id)
        return { kind: 'rollback' }
      }
      const forked = await forkCheckpoint(projectId, pending.checkpoint.checkpoint_id)
      return { kind: 'fork', project_id: forked.project_id }
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['loopit-run', runId] })
      if (result.kind === 'rollback') {
        queryClient.invalidateQueries({ queryKey: ['loopit-file', runId] })
        queryClient.invalidateQueries({ queryKey: ['loopit-preview'] })
      }
    },
  })
}

/** Approve or reject a human gate, then refresh the run. */
export function useGateDecision(runId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ gate, approved }: { gate: ApprovalGate; approved: boolean }) => {
      const reason = approved ? 'approved by user in the build page' : 'rejected by user in the build page'
      if (approved) await approveGate(runId, gate.gate_id, reason)
      else await rejectGate(runId, gate.gate_id, reason)
      return gate.gate_id
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['loopit-run', runId] }),
  })
}

/**
 * Signed preview URL. Refetches at ~80% of the token TTL so the iframe does
 * not 401 after the default 900 s expiry. Remounting is left to the caller
 * (key on `url` only when the string actually changes).
 */
export function usePreviewUrl(projectId: string | null, path: string | null) {
  return useQuery<PreviewUrl>({
    queryKey: ['loopit-preview', projectId, path],
    queryFn: () => createPreviewUrl(projectId as string, path as string),
    enabled: typeof window !== 'undefined' && !!projectId && !!path,
    retry: false,
    staleTime: Infinity,
    refetchInterval: (q) => {
      const data = q.state.data
      if (!data) return false
      const remaining = data.expiresAt - Date.now()
      if (remaining <= 0) return 5_000
      // Refresh at 80% of remaining life (≈ 720 s on a fresh 900 s token).
      return Math.max(Math.floor(remaining * 0.8), 5_000)
    },
  })
}

/** Read one workspace file's text (read-only code view for the preview tabs). */
export function useFileContent(runId: string, path: string | null) {
  return useQuery<string>({
    queryKey: ['loopit-file', runId, path],
    queryFn: async () => (await getFile(runId, path as string)) ?? '',
    enabled: typeof window !== 'undefined' && !!runId && runId !== '_' && !!path,
    retry: false,
  })
}

export type UseRunStreamOptions = {
  /** When true, reconnect after a clean close (proxy idle cut) while the run is live. */
  live?: boolean
}

/**
 * Live audit/DAG/gate stream. Retries a dropped connection while enabled.
 * On a clean close while `live` is still true, reconnects with `?after=<lastSeq>`
 * so the engine can skip the replay prefix (engine must honour `after`).
 */
export function useRunStream(
  runId: string,
  enabled: boolean,
  onEvent: (event: StreamEvent) => void,
  options: UseRunStreamOptions = {},
) {
  const onEventRef = useRef(onEvent)
  onEventRef.current = onEvent
  const liveRef = useRef(!!options.live)
  liveRef.current = !!options.live
  const lastSeqRef = useRef(0)

  useEffect(() => {
    if (!enabled || !runId || runId === '_') return
    const controller = new AbortController()
    let cancelled = false
    const errorDelays = [0, 500, 1500, 3000]
    const reconnectDelays = [500, 1500, 3000, 5000]

    ;(async () => {
      let errorAttempt = 0
      let reconnectAttempt = 0
      while (!cancelled) {
        try {
          const after = lastSeqRef.current > 0 ? lastSeqRef.current : undefined
          await streamRunEvents(
            runId,
            (event) => {
              if (cancelled) return
              const seq = (event as { _seq?: unknown })._seq
              if (typeof seq === 'number' && seq > lastSeqRef.current) {
                lastSeqRef.current = seq
              }
              onEventRef.current(event)
            },
            { signal: controller.signal, after },
          )
          if (cancelled || controller.signal.aborted) return
          // Clean close: only reopen while the run is still live.
          if (!liveRef.current) return
          const delay = reconnectDelays[Math.min(reconnectAttempt, reconnectDelays.length - 1)] ?? 5000
          reconnectAttempt += 1
          errorAttempt = 0
          await sleep(delay)
        } catch (cause) {
          if (controller.signal.aborted || cancelled) return
          if (errorAttempt >= errorDelays.length - 1) {
            onEventRef.current({ kind: 'error', message: toUserFacingError(cause).message })
            return
          }
          const delay = errorDelays[errorAttempt + 1] ?? 3000
          errorAttempt += 1
          await sleep(delay)
        }
      }
    })()
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [enabled, runId])
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { window.setTimeout(resolve, ms) })
}

/** Exported for unit tests — delay until the next preview refresh. */
export function previewRefreshDelayMs(expiresAt: number, now = Date.now()): number {
  const remaining = expiresAt - now
  if (remaining <= 0) return 5_000
  return Math.max(Math.floor(remaining * 0.8), 5_000)
}

export { PREVIEW_TTL_SECONDS }
