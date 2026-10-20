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
 *   recording → (⏸ Stop / Release) distilling → skill_saved → done → idle
 * Success is driven by the explicit `skill_saved` event (not a timer).
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
  skillId: string | null
  start: (goal: string) => Promise<void>
  takeOver: () => Promise<void>
  stop: () => Promise<void>
  cancel: () => Promise<void>
  reset: () => void
}

/** The session object components consume (AgentComputerTab's teach pill). */
export type TeachSession = TeachSessionState

const FRAME_RE = /Recording the demonstration…\s*(\d+) frame/
const START_TIMEOUT_MS = 90_000
const DISTILL_TIMEOUT_MS = 120_000

export function useTeachSession(onSkillReady?: (skillId?: string) => void, botId?: string | null): TeachSessionState {
  const [phase, setPhase] = useState<TeachPhase>('idle')
  const [goal, setGoal] = useState<string | null>(null)
  const [taskId, setTaskId] = useState<string | null>(null)
  const [runId, setRunId] = useState<string | null>(null)
  const [computer, setComputer] = useState<BotComputer | null>(null)
  const [frames, setFrames] = useState(0)
  const [error, setError] = useState('')
  const [skillId, setSkillId] = useState<string | null>(null)
  const stopStreamRef = useRef<(() => void) | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const computerPollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const phaseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const doneTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const taskIdRef = useRef<string | null>(null)
  const phaseRef = useRef<TeachPhase>('idle')

  useEffect(() => { phaseRef.current = phase }, [phase])

  const clearTimers = useCallback(() => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
    if (computerPollRef.current) { clearInterval(computerPollRef.current); computerPollRef.current = null }
    if (phaseTimerRef.current) { clearTimeout(phaseTimerRef.current); phaseTimerRef.current = null }
    if (doneTimerRef.current) { clearTimeout(doneTimerRef.current); doneTimerRef.current = null }
    stopStreamRef.current?.(); stopStreamRef.current = null
  }, [])

  const fail = useCallback((message: string) => {
    clearTimers()
    setError(message)
    setPhase('failed')
  }, [clearTimers])

  const reset = useCallback(() => {
    clearTimers()
    setPhase('idle'); setGoal(null); setTaskId(null); setRunId(null)
    taskIdRef.current = null
    setComputer(null); setFrames(0); setError(''); setSkillId(null)
  }, [clearTimers])

  const handleEvent = useCallback((event: BotEvent) => {
    if (event.type === 'skill_saved') {
      const id = event.skillId || (event.data as { skillId?: string } | undefined)?.skillId || null
      setSkillId(id)
      if (phaseTimerRef.current) { clearTimeout(phaseTimerRef.current); phaseTimerRef.current = null }
      onSkillReady?.(id || undefined)
      setPhase('done')
      if (doneTimerRef.current) clearTimeout(doneTimerRef.current)
      doneTimerRef.current = setTimeout(() => reset(), 3500)
      return
    }
    if (event.type === 'status') {
      const msg = event.message || ''
      const m = FRAME_RE.exec(msg)
      if (m) { setFrames(Number(m[1])); setPhase('recording'); return }
      if (/Waiting for the operator/i.test(msg)) setPhase((p) => (p === 'recording' ? p : 'waiting'))
      return
    }
    if (event.type === 'final' || event.type === 'done') {
      // Distilling until skill_saved lands — do not treat this as success.
      setPhase((p) => (p === 'failed' || p === 'done' ? p : 'distilling'))
      if (phaseTimerRef.current) clearTimeout(phaseTimerRef.current)
      phaseTimerRef.current = setTimeout(() => {
        if (phaseRef.current === 'distilling') {
          fail('The skill did not save in time. Try teaching again.')
        }
      }, DISTILL_TIMEOUT_MS)
      return
    }
    if (event.type === 'error') {
      fail(event.message || 'The teach session failed.')
    }
  }, [onSkillReady, reset, fail])

  const start = useCallback(async (teachGoal: string) => {
    if (phase !== 'idle' && phase !== 'failed') return
    clearTimers()
    setError('')
    setSkillId(null)
    setFrames(0)
    setPhase('starting')
    setGoal(teachGoal)
    phaseTimerRef.current = setTimeout(() => {
      if (phaseRef.current === 'starting' || phaseRef.current === 'waiting') {
        fail('Timed out waiting for the teach computer. Cancel and try again.')
      }
    }, START_TIMEOUT_MS)
    try {
      const res = await enqueueBotTask({
        goal: teachGoal,
        kind: 'teach',
        maxSteps: 16,
        computer: { enabled: true, ttlMinutes: 30 },
        ...(botId ? { botId } : {}),
      })
      const id = res.task.id
      setTaskId(id)
      taskIdRef.current = id
      // Wait for the worker to claim the task and spawn a run.
      pollRef.current = setInterval(async () => {
        try {
          const detail = await getBotTask(id)
          if (detail.status === 'dead_letter') {
            fail(detail.lastErrorCode
              ? `Teach failed — ${detail.lastErrorCode.replace(/^BOT_/, '').replace(/_/g, ' ').toLowerCase()}`
              : 'Teach failed.')
            return
          }
          if (detail.status === 'cancelled' || detail.cancelRequested) {
            fail('Teach session was cancelled.')
            return
          }
          const run = detail.runs?.[0]
          if (!run) return
          if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
          setRunId(run.id)
          stopStreamRef.current = streamBotRun(run.id, handleEvent, undefined, (msg) => {
            fail(msg)
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
      fail(err?.message || 'Could not start the teach session.')
    }
  }, [phase, handleEvent, botId, clearTimers, fail])

  const takeOver = useCallback(async () => {
    if (!runId) return
    try {
      await setBotTakeover(runId, true)
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
    if (phaseTimerRef.current) clearTimeout(phaseTimerRef.current)
    phaseTimerRef.current = setTimeout(() => {
      if (phaseRef.current === 'distilling') {
        fail('The skill did not save in time. Try teaching again.')
      }
    }, DISTILL_TIMEOUT_MS)
    try {
      await setBotTakeover(runId, false)
    } catch { /* the run may already be over — skill_saved resolves it */ }
    setComputer((cur) => (cur ? { ...cur, takeoverRequested: false } : cur))
  }, [runId, fail])

  const cancel = useCallback(async () => {
    const id = taskIdRef.current
    clearTimers()
    if (id) await cancelBotTask(id).catch(() => {})
    setPhase('failed')
    setError('Teach session cancelled.')
  }, [clearTimers])

  useEffect(() => clearTimers, [clearTimers])

  return { phase, goal, taskId, runId, computer, frames, error, skillId, start, takeOver, stop, cancel, reset }
}
