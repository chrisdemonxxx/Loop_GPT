'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { BotFeedEvent } from '@loop/shared'
import { API_URL, authHeaders } from './api'

/**
 * Fetch-based SSE reader for bot runs. EventSource can't carry the Bearer
 * token, so we read the stream manually: parse `data:` frames, skip `:`
 * keepalive comments, auto-reconnect, and fall back to polling when the
 * stream keeps dying (the run feed endpoints work both ways).
 */

/** Raw reader: opens the SSE stream, dispatches events, resolves on done.
 *  Throws on network failure so the caller can retry or fall back. */
export async function readBotRunStream(
  base: string,
  runId: string,
  onEvent: (event: BotFeedEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const res = await fetch(`${API_URL}${base}/runs/${runId}/events`, {
    credentials: 'include',
    headers: authHeaders(false),
    signal,
  })
  if (!res.ok || !res.body) throw new Error(`stream ${res.status}`)
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let index: number
    while ((index = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, index)
      buffer = buffer.slice(index + 2)
      for (const line of frame.split('\n')) {
        if (!line.startsWith('data:')) continue // ': connected', ': hb', empty
        try {
          const event = JSON.parse(line.slice(5).trim()) as BotFeedEvent
          if (event.type === 'done') { reader.cancel().catch(() => {}); return }
          onEvent(event)
        } catch { /* partial frame; next chunk completes it */ }
      }
    }
  }
}

/**
 * Live run feed hook: SSE with bounded reconnect, then DB-poll fallback.
 * While connected, events arrive in real time; the poll fallback keeps the
 * page functional forever even if SSE is blocked by an intermediary.
 */
export function useBotRunFeed(base: string, runId: string | null, refreshMs = 4000) {
  const [events, setEvents] = useState<BotFeedEvent[]>([])
  const [connected, setConnected] = useState(false)
  const [usingPoll, setUsingPoll] = useState(false)
  const attemptRef = useRef(0)

  useEffect(() => {
    if (!runId) { setEvents([]); setConnected(false); setUsingPoll(false); return }
    let stop = false
    const controller = new AbortController()
    setEvents([]) // new run selected: fresh feed

    const startStream = async () => {
      while (!stop) {
        try {
          setConnected(true); setUsingPoll(false)
          await readBotRunStream(base, runId, (event) => {
            if (stop) return
            setEvents((prev) => {
              const next = [...prev, event]
              return next.length > 400 ? next.slice(-400) : next
            })
          }, controller.signal)
          return // clean done: the run finished
        } catch {
          setConnected(false)
          if (stop || controller.signal.aborted) return
          attemptRef.current += 1
          if (attemptRef.current >= 3) break // fall back to polling
          await new Promise((r) => setTimeout(r, 1000 * attemptRef.current))
        }
      }
      if (!stop) { // poll fallback: read the whole run every refreshMs
        setUsingPoll(true)
        while (!stop) {
          try {
            const res = await fetch(`${API_URL}${base}/runs/${runId}`, { headers: authHeaders(false), signal: controller.signal })
            if (res.ok) {
              const run = await res.json()
              if (!stop) setEvents(Array.isArray(run.events) ? run.events : [])
              if (run.status !== 'running') return
            }
          } catch { /* keep trying */ }
          await new Promise((r) => setTimeout(r, refreshMs))
        }
      }
    }
    startStream()
    return () => { stop = true; attemptRef.current = 0; controller.abort() }
  }, [base, runId, refreshMs])

  return { events, connected, usingPoll }
}

export type { BotFeedEvent }