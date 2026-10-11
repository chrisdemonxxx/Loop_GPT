'use client'

import { useEffect, useRef, useState } from 'react'
import { getBotTask, getBotComputer, streamBotRun } from '../../lib/bot'
import type { BotComputer, BotEvent, BotTaskDetail } from '../../lib/bot'

/**
 * Run-stream lifecycle for the team-bot run viewer: load the task, follow its
 * latest run over SSE (replay + live attach, never polling), refresh the
 * dedicated computer's metadata while the run is live. The viewer composes
 * this with the trace + computer panes; nothing else owns stream state.
 */
export function useRunStream(taskId: string) {
  const [task, setTask] = useState<BotTaskDetail | null>(null)
  const [runId, setRunId] = useState<string | null>(null)
  const [events, setEvents] = useState<BotEvent[]>([])
  const [live, setLive] = useState(false)
  const [computer, setComputer] = useState<BotComputer | null>(null)
  const [loadError, setLoadError] = useState('')
  const runIdRef = useRef<string | null>(null)

  // Load the task, then follow its latest run (SSE, not polling).
  useEffect(() => {
    let stop: (() => void) | null = null
    let cancelled = false
    ;(async () => {
      try {
        const detail = await getBotTask(taskId)
        if (cancelled) return
        setTask(detail)
        const latest = detail.runs?.[0]
        if (!latest) { setLoadError('No run yet — the worker picks tasks up every few seconds.'); return }
        setRunId(latest.id)
        runIdRef.current = latest.id
        setLive(latest.status === 'running')
        stop = streamBotRun(
          latest.id,
          (event) => { setEvents((prev) => [...prev.slice(-399), event]); if (event.type === 'final') setLive(false) },
          () => setLive(false),
          (msg) => { setLoadError(msg); setLive(false) },
        )
        const comp = await getBotComputer(latest.id).catch(() => null)
        if (!cancelled && comp?.sandboxId) setComputer(comp)
      } catch (err: any) {
        if (!cancelled) setLoadError(err?.message || 'Could not load the run.')
      }
    })()
    return () => { cancelled = true; stop?.() }
  }, [taskId])

  // Refresh computer metadata while the run is live (minutes tick up), and
  // once more when it ends: the worker destroys the dedicated VM at run end,
  // so the last fetch flips active→false and the pane swaps from a dead
  // iframe (black screen) to the honest offline state.
  useEffect(() => {
    if (!runId || !computer) return
    if (!live) {
      void getBotComputer(runId).then((comp) => { if (comp?.sandboxId) setComputer(comp) }).catch(() => undefined)
      return
    }
    const t = setInterval(async () => {
      const comp = await getBotComputer(runId).catch(() => null)
      if (comp?.sandboxId) setComputer(comp)
    }, 15_000)
    return () => clearInterval(t)
  }, [runId, live, computer])

  return { task, runId, events, live, computer, setComputer, loadError, setLoadError, runIdRef }
}