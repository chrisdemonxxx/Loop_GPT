'use client'

import { useEffect, useRef } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  approveGate,
  createPreviewUrl,
  deployProject,
  forkCheckpoint,
  getRun,
  listRuns,
  rejectGate,
  rollbackCheckpoint,
  startRun,
  streamRunEvents,
  toUserFacingError,
  type ApprovalGate,
  type CheckpointView,
  type RunDetail,
  type RunSummary,
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

export function useStartBuild() {
  const queryClient = useQueryClient()
  return useMutation({
    // Effort is elastic and decided by the engine's brief; the product UI
    // sends only what the person typed.
    mutationFn: (input: { prompt: string }) => startRun(input.prompt),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['loopit-runs'] }),
  })
}

export type CheckpointAction = { kind: 'deploy' | 'rollback' | 'fork'; checkpoint: CheckpointView }

/** Deploy / roll back / fork a checkpoint, then refresh the run. */
export function useCheckpointAction(runId: string, projectId: string | null) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ pending, reason }: { pending: CheckpointAction; reason: string }) => {
      if (!projectId) throw new Error('This build has no project yet')
      if (pending.kind === 'deploy') return deployProject(projectId, pending.checkpoint.checkpoint_id, reason)
      if (pending.kind === 'rollback') {
        await rollbackCheckpoint(projectId, pending.checkpoint.checkpoint_id)
        return null
      }
      return forkCheckpoint(projectId, pending.checkpoint.checkpoint_id)
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['loopit-run', runId] }),
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

export function usePreviewUrl(projectId: string | null, path: string | null) {
  return useQuery<string>({
    queryKey: ['loopit-preview', projectId, path],
    queryFn: () => createPreviewUrl(projectId as string, path as string),
    enabled: typeof window !== 'undefined' && !!projectId && !!path,
    retry: false,
  })
}

/** Live audit/DAG/gate stream. Retries a dropped connection while the caller keeps it enabled. */
export function useRunStream(runId: string, enabled: boolean, onEvent: (event: StreamEvent) => void) {
  const onEventRef = useRef(onEvent)
  onEventRef.current = onEvent
  useEffect(() => {
    if (!enabled || !runId || runId === '_') return
    const controller = new AbortController()
    let cancelled = false
    const delays = [0, 500, 1500, 3000]
    ;(async () => {
      for (let attempt = 0; attempt < delays.length && !cancelled; attempt += 1) {
        if (delays[attempt]) await sleep(delays[attempt] ?? 0)
        if (cancelled) return
        try {
          await streamRunEvents(runId, (event) => { if (!cancelled) onEventRef.current(event) }, controller.signal)
          return
        } catch (cause) {
          if (controller.signal.aborted || cancelled) return
          if (attempt === delays.length - 1) {
            onEventRef.current({ kind: 'error', message: toUserFacingError(cause).message })
          }
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
