'use client'

import { useEffect, useRef } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  createPreviewUrl,
  getRun,
  listRuns,
  startRun,
  streamRunEvents,
  toUserFacingError,
  type RunDetail,
  type RunSummary,
  type StreamEvent,
} from '@loop/loopit-client'

export function useBuildRuns() {
  const query = useQuery<RunSummary[]>({
    queryKey: ['loopit-runs'],
    queryFn: () => listRuns(),
    enabled: typeof window !== 'undefined',
    retry: false,
    refetchInterval: (q) => {
      const runs = q.state.data
      if (!Array.isArray(runs)) return false
      return runs.some((run) => run.status === 'running') ? 4000 : false
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
    refetchInterval: (q) => (q.state.data?.status === 'running' ? 3000 : false),
  })
}

export function useStartBuild() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: { prompt: string; maxIterations: number }) =>
      startRun(input.prompt, { maxIterations: input.maxIterations }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['loopit-runs'] }),
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
