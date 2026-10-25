'use client'

import { useEffect, useRef, useState } from 'react'
import { getBotTask, getBotComputer, streamBotRun } from '../../lib/bot'
import type { BotComputer, BotEvent, BotTaskDetail } from '../../lib/bot'

/**
 * Run-stream lifecycle for the team-bot run viewer: load the task, follow its
 * latest run over SSE (replay + live attach, with reconnect), refresh the
 * computer metadata while the run is live. The viewer composes this with the
 * trace pane; nothing else owns stream state.
 */
export function useRunStream(taskId: string) {
  const [task, setTask] = useState<BotTaskDetail | null>(null)
  const [runId, setRunId] = useState<string | null>(null)
  const [events, setEvents] = useState<BotEvent[]>([])
  const [live, setLive] = useState(false)
  const [computer, setComputer] = useState<BotComputer | null>(null)
  const [loadError, setLoadError] = useState('')
  const [ended, setEnded] = useState(false)
  const [connectAttempt, setConnectAttempt] = useState(0)
  const runIdRef = useRef<string | null>(null)

  const retry = () => {
    setLoadError('')
    setConnectAttempt((n) => n + 1)
  }

  // Load the task, wait for a run if the worker hasn't claimed yet, then SSE.
  // A new taskId or a Dismiss/retry drops the previous run before attaching.
  useEffect(() => {
    let stop: (() => void) | null = null
    let cancelled = false
    let waitTimer: ReturnType<typeof setTimeout> | null = null
    let attempts = 0
    setTask(null)
    setRunId(null)
    runIdRef.current = null
    setEvents([])
    setComputer(null)
    setLive(false)
    setEnded(false)
    setLoadError('')

    const attach = (id: string, status: string) => {
      if (cancelled) return
      setRunId(id)
      runIdRef.current = id
      setLive(status === 'running')
      setLoadError('')
      stop = streamBotRun(
        id,
        (event) => {
          if (cancelled) return
          setEvents((prev) => [...prev.slice(-399), event])
          if (event.type === 'final' || event.type === 'done') {
            setLive(false)
            setEnded(true)
            void getBotTask(taskId).then((detail) => {
              if (!cancelled) setTask(detail)
            }).catch(() => undefined)
          }
        },
        () => { if (!cancelled) { setLive(false); setEnded(true) } },
        (msg) => { if (!cancelled) { setLoadError(msg); setLive(false); setEnded(true) } },
      )
      void getBotComputer(id).then((comp) => {
        if (!cancelled && comp?.sandboxId) setComputer(comp)
      }).catch(() => undefined)
    }

    const load = async () => {
      try {
        const detail = await getBotTask(taskId)
        if (cancelled) return
        setTask(detail)
        const latest = detail.runs?.[0]
        if (!latest) {
          // Worker claims every few seconds — retry instead of a hard error.
          attempts += 1
          if (attempts > 30) {
            setLoadError('No run yet — the worker may be offline.')
            return
          }
          setLoadError('')
          waitTimer = setTimeout(() => { void load() }, 2000)
          return
        }
        attach(latest.id, latest.status)
      } catch (err: any) {
        if (!cancelled) setLoadError(err?.message || 'Could not load the run.')
      }
    }

    void load()
    return () => {
      cancelled = true
      if (waitTimer) clearTimeout(waitTimer)
      stop?.()
    }
  }, [taskId, connectAttempt])

  // Keep header status live while the run is in flight (task status + result).
  useEffect(() => {
    if (!taskId || !live) return
    const t = setInterval(() => {
      void getBotTask(taskId).then((detail) => setTask(detail)).catch(() => undefined)
    }, 8_000)
    return () => clearInterval(t)
  }, [taskId, live])

  // Refresh computer metadata while live. Do NOT depend on `computer` — that
  // caused a hot loop (every setComputer restarted the interval).
  useEffect(() => {
    if (!runId) return
    if (!live) {
      void getBotComputer(runId).then((comp) => {
        if (comp?.sandboxId) setComputer(comp)
      }).catch(() => undefined)
      return
    }
    const t = setInterval(async () => {
      const comp = await getBotComputer(runId).catch(() => null)
      if (comp?.sandboxId) setComputer(comp)
    }, 15_000)
    return () => clearInterval(t)
  }, [runId, live])

  return { task, runId, events, live, ended, computer, setComputer, loadError, setLoadError, retry, runIdRef }
}
