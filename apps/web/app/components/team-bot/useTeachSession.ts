'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  enqueueBotTask, getBotTask, getBotComputer, setBotTakeover, cancelBotTask, streamBotRun,
  type BotComputer, type BotEvent,
} from '../../lib/bot'

/**
 * The Grok-style "Teach a task" session machine:
 *   idle → (⏺ click) starting → computer boots, bot waits → waiting
 *   waiting → (operator takes over) recording (frames accumulate live)
 *   recording → (⏸ Stop / Release) distilling → skill created → done → idle
 * The backend (botRunner teach flow) does the recording + distillation; this
 * hook drives the session over the existing owner-scoped API and mirrors the
 * run's status events into a UI-friendly phase + live frame counter.
 */
export type TeachPhase = 'idle' | 'starting' | 'waiting' | 'recording' | 'distilling' | 'done' | 'failed'

export interface TeachSessionState {
  phase: TeachPhase
  goal: string | null
  taskId: string | null
  runId: string | null
  computer: BotComputer | null
  frames: number
  error: string
  start: (goal: string) => Promise<void>
  takeOver: () => Promise<void>
  stop: () => Promise<void>
  reset: () => void
}

/** The session object components consume (AgentComputerTab's teach pill). */
export type TeachSession = TeachSessionState

const FRAME_RE = /Recording the demonstration…\s*(\d+) frame/

export function useTeachSession(onSkillReady?: () => void, botId?: string | null): TeachSessionState {
  const [phase, setPhase] = useState<TeachPhase>('idle')
  const [goal, setGoal] = useState<string | null>(null)
  const [taskId, setTaskId] = useState<string | null>(null)
  const [runId, setRunId] = useState<string | null>(null)
  const [computer, setComputer] = useState<BotComputer | null>(null)
  const [frames, setFrames] = useState(0)
  const [error, setError] = useState('')
  const stopStreamRef = useRef<(() => void) | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const computerPollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const doneTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearTimers = useCallback(() => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
    if (computerPollRef.current) { clearInterval(computerPollRef.current); computerPollRef.current = null }
    if (doneTimerRef.current) { clearTimeout(doneTimerRef.current); doneTimerRef.current = null }
    stopStreamRef.current?.(); stopStreamRef.current = null
  }, [])

  const reset = useCallback(() => {
    clearTimers()
    setPhase('idle'); setGoal(null); setTaskId(null); setRunId(null)
    setComputer(null); setFrames(0); setError('')
  }, [clearTimers])

  const handleEvent = useCallback((event: BotEvent) => {
    if (event.type === 'status') {
      const msg = event.message || ''
      const m = FRAME_RE.exec(msg)
      if (m) { setFrames(Number(m[1])); setPhase('recording'); return }
      if (/Waiting for the operator/i.test(msg)) setPhase((p) => (p === 'recording' ? p : 'waiting'))
      return
    }
    if (event.type === 'final' || event.type === 'done') {
      setPhase((p) => (p === 'failed' ? p : 'distilling'))
      // The skill write happens inside the model's final steps; give the
      // Library a moment to land, then surface it and settle.
      if (doneTimerRef.current) clearTimeout(doneTimerRef.current)
      doneTimerRef.current = setTimeout(() => {
        onSkillReady?.()
        setPhase('done')
        doneTimerRef.current = setTimeout(() => reset(), 3500)
      }, 4000)
      return
    }
    if (event.type === 'error') {
      setError(event.message || 'The teach session failed.')
      setPhase('failed')
    }
  }, [onSkillReady, reset])

  const start = useCallback(async (teachGoal: string) => {
    if (phase !== 'idle') return
    setError('')
    setPhase('starting')
    setGoal(teachGoal)
    try {
      const res = await enqueueBotTask({
        goal: teachGoal,
        kind: 'teach',
        maxSteps: 16,
        // The demonstration computer: a full session window (backend's teach
        // timeout is the hard ceiling; default 30 min).
        computer: { enabled: true, ttlMinutes: 30 },
        ...(botId ? { botId } : {}),
      })
      const id = res.task.id
      setTaskId(id)
      // Wait for the worker to claim the task and spawn a run.
      pollRef.current = setInterval(async () => {
        try {
          const detail = await getBotTask(id)
          const run = detail.runs?.[0]
          if (!run) return
          if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
          setRunId(run.id)
          stopStreamRef.current = streamBotRun(run.id, handleEvent, undefined, (msg) => {
            setError(msg)
            setPhase('failed')
          })
          const comp = await getBotComputer(run.id).catch(() => null)
          if (comp?.sandboxId) setComputer(comp)
          computerPollRef.current = setInterval(async () => {
            const c = await getBotComputer(run.id).catch(() => null)
            if (c?.sandboxId) setComputer(c)
          }, 5000)
        } catch { /* keep polling — worker picks tasks up every few seconds */ }
      }, 2000)
    } catch (err: any) {
      setError(err?.message || 'Could not start the teach session.')
      setPhase('failed')
    }
  }, [phase, handleEvent, botId])

  const takeOver = useCallback(async () => {
    if (!runId) return
    try {
      await setBotTakeover(runId, true)
      // Only flip local state after the server confirms — the old code set it
      // unconditionally, so a 409 (run already finished) desynced the UI into
      // a phantom "you're driving" state over a dead VM.
      setComputer((cur) => (cur ? { ...cur, takeoverRequested: true } : cur))
    } catch (err: any) {
      setError(err?.message || 'Takeover failed — the session may already be over.')
    }
  }, [runId])

  /** Stop = Release: the operator hands the computer back, the bot distills
   *  the recorded frames into a Skill. */
  const stop = useCallback(async () => {
    if (!runId) return
    setPhase('distilling')
    try {
      await setBotTakeover(runId, false)
    } catch { /* the run may already be over — the distillation poll resolves it */ }
    setComputer((cur) => (cur ? { ...cur, takeoverRequested: false } : cur))
  }, [runId])

  useEffect(() => clearTimers, [clearTimers])

  return { phase, goal, taskId, runId, computer, frames, error, start, takeOver, stop, reset }
}