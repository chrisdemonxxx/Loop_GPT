'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  enqueueBotTask, getBotTask, getBotComputer, setBotTakeover, cancelBotTask, streamBotRun,
  appendBotTeachStep,
  type BotComputer, type BotEvent, type BotTeachStep,
} from '../../lib/bot'

/**
 * Teach recording:
 *   idle → Start recording → starting (enqueue kind=teach if needed)
 *   starting → takeover on → recording (clicks/keys/frames; no skill yet)
 *   recording → Stop → distilling → skill_saved → done → idle
 * skill_saved is ignored unless Stop has moved the phase to distilling.
 * Cancel never writes a skill.
 */
export type TeachPhase = 'idle' | 'starting' | 'waiting' | 'recording' | 'distilling' | 'done' | 'failed'

export type TeachOperatorInput = Omit<BotTeachStep, 'at'>

export interface TeachSessionState {
  phase: TeachPhase
  goal: string | null
  taskId: string | null
  runId: string | null
  computer: BotComputer | null
  frames: number
  steps: number
  error: string
  skillId: string | null
  skillName: string | null
  start: (goal: string) => Promise<void>
  takeOver: () => Promise<void>
  /** Release takeover and distill. Only valid while recording. */
  stop: () => Promise<void>
  cancel: () => Promise<void>
  reset: () => void
  /** Post one operator input while recording. No-op in every other phase. */
  reportInput: (input: TeachOperatorInput) => void
}

/** The session object components consume (AgentComputerTab). */
export type TeachSession = TeachSessionState

const FRAME_RE = /Recording the demonstration…\s*(\d+) frame/
const NOTHING_RECORDED_RE = /nothing was recorded/i
const START_TIMEOUT_MS = 90_000
const DISTILL_TIMEOUT_MS = 120_000

export function useTeachSession(
  onSkillReady?: (skillId?: string) => void,
  botId?: string | null,
  conversationId?: string | null,
): TeachSessionState {
  const [phase, setPhase] = useState<TeachPhase>('idle')
  const [goal, setGoal] = useState<string | null>(null)
  const [taskId, setTaskId] = useState<string | null>(null)
  const [runId, setRunId] = useState<string | null>(null)
  const [computer, setComputer] = useState<BotComputer | null>(null)
  const [frames, setFrames] = useState(0)
  const [steps, setSteps] = useState(0)
  const [error, setError] = useState('')
  const [skillId, setSkillId] = useState<string | null>(null)
  const [skillName, setSkillName] = useState<string | null>(null)
  const stopStreamRef = useRef<(() => void) | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const computerPollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const phaseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const doneTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const taskIdRef = useRef<string | null>(null)
  const runIdRef = useRef<string | null>(null)
  const phaseRef = useRef<TeachPhase>('idle')
  /** True only after the operator presses Stop. Early skill_saved must not finish the session. */
  const distillArmedRef = useRef(false)
  const abandoningRef = useRef(false)
  /** Bumped when a new start/reset begins so an in-flight cancel cannot overwrite it. */
  const generationRef = useRef(0)

  const movePhase = useCallback((next: TeachPhase) => {
    phaseRef.current = next
    setPhase(next)
  }, [])

  const clearTimers = useCallback(() => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
    if (computerPollRef.current) { clearInterval(computerPollRef.current); computerPollRef.current = null }
    if (phaseTimerRef.current) { clearTimeout(phaseTimerRef.current); phaseTimerRef.current = null }
    if (doneTimerRef.current) { clearTimeout(doneTimerRef.current); doneTimerRef.current = null }
    stopStreamRef.current?.(); stopStreamRef.current = null
  }, [])

  const fail = useCallback((message: string) => {
    clearTimers()
    distillArmedRef.current = false
    setSkillId(null)
    setSkillName(null)
    setError(message)
    movePhase('failed')
  }, [clearTimers, movePhase])

  const reset = useCallback(() => {
    generationRef.current += 1
    clearTimers()
    distillArmedRef.current = false
    abandoningRef.current = false
    movePhase('idle'); setGoal(null); setTaskId(null); setRunId(null)
    taskIdRef.current = null
    runIdRef.current = null
    setComputer(null); setFrames(0); setSteps(0); setError(''); setSkillId(null); setSkillName(null)
  }, [clearTimers, movePhase])

  /**
   * Release takeover and cancel the task. Discard, close, unmount, and the
   * start timeout all come through here. Does not save a skill.
   */
  const abandon = useCallback(async (message: string) => {
    if (abandoningRef.current) return
    const phase = phaseRef.current
    if (phase === 'idle' || phase === 'done' || phase === 'distilling' || phase === 'failed') return
    abandoningRef.current = true
    const gen = generationRef.current
    const task = taskIdRef.current
    const run = runIdRef.current
    distillArmedRef.current = false
    clearTimers()
    movePhase('failed')
    setSkillId(null)
    setSkillName(null)
    let note = message
    if (run) {
      try {
        await setBotTakeover(run, false)
      } catch (err: unknown) {
        const extra = err instanceof Error && err.message ? err.message : 'Could not release control.'
        note = `${note} ${extra}`.trim()
      }
    }
    if (task) {
      try {
        await cancelBotTask(task)
      } catch (err: unknown) {
        const extra = err instanceof Error && err.message ? err.message : 'Could not cancel the teach task.'
        note = `${note} ${extra}`.trim()
      }
    }
    if (generationRef.current !== gen) return
    setComputer((cur) => (cur ? { ...cur, takeoverRequested: false } : cur))
    setError(note)
    abandoningRef.current = false
  }, [clearTimers, movePhase])

  const armDistillTimeout = useCallback(() => {
    if (phaseTimerRef.current) clearTimeout(phaseTimerRef.current)
    phaseTimerRef.current = setTimeout(() => {
      if (phaseRef.current === 'distilling') {
        fail('The skill did not save in time. Try teaching again.')
      }
    }, DISTILL_TIMEOUT_MS)
  }, [fail])

  const handleEvent = useCallback((event: BotEvent) => {
    const message = event.message || ''
    if (NOTHING_RECORDED_RE.test(message)) {
      setSkillId(null)
      setSkillName(null)
      fail(message)
      return
    }
    if (event.type === 'skill_saved') {
      // A model turn can emit this during boot, before the operator has recorded anything.
      if (phaseRef.current !== 'distilling' || !distillArmedRef.current) return
      const id = event.skillId || (event.data as { skillId?: string } | undefined)?.skillId || null
      const name = event.name || (event.data as { name?: string } | undefined)?.name || null
      setSkillId(id)
      setSkillName(name)
      if (phaseTimerRef.current) { clearTimeout(phaseTimerRef.current); phaseTimerRef.current = null }
      onSkillReady?.(id || undefined)
      movePhase('done')
      if (doneTimerRef.current) clearTimeout(doneTimerRef.current)
      doneTimerRef.current = setTimeout(() => reset(), 3500)
      return
    }
    if (event.type === 'status') {
      const m = FRAME_RE.exec(message)
      if (m) {
        setFrames(Number(m[1]))
        if (phaseRef.current !== 'distilling' && phaseRef.current !== 'done' && phaseRef.current !== 'failed') {
          movePhase('recording')
        }
        return
      }
      if (/Waiting for the operator/i.test(message)) {
        if (phaseRef.current === 'recording' || phaseRef.current === 'distilling' || phaseRef.current === 'done' || phaseRef.current === 'failed') return
        movePhase('waiting')
      }
      return
    }
    if (event.type === 'final' || event.type === 'done') {
      // Stop is what enters distilling. A phase-1 final must not finish the skill.
      if (phaseRef.current === 'distilling') armDistillTimeout()
      return
    }
    if (event.type === 'error') {
      fail(message || 'The teach session failed.')
    }
  }, [onSkillReady, reset, fail, movePhase, armDistillTimeout])

  /** Takeover on, then recording. The returned interactive URL is applied before any poll. */
  const armRecording = useCallback(async (id: string) => {
    let taken: { takeoverRequested: boolean; interactiveUrl: string | null }
    try {
      taken = await setBotTakeover(id, true)
    } catch (err: any) {
      if (phaseRef.current === 'failed' || phaseRef.current === 'idle') return
      setError(err?.message || 'Takeover failed — the session may already be over.')
      movePhase('waiting')
      return
    }
    if (phaseRef.current !== 'starting' && phaseRef.current !== 'waiting' && phaseRef.current !== 'recording') return
    if (phaseTimerRef.current) { clearTimeout(phaseTimerRef.current); phaseTimerRef.current = null }
    setComputer((cur) => ({
      active: cur?.active ?? true,
      reason: cur?.reason ?? null,
      sandboxId: cur?.sandboxId ?? '',
      viewUrl: cur?.viewUrl ?? null,
      interactiveUrl: taken.interactiveUrl ?? cur?.interactiveUrl ?? null,
      takeoverRequested: true,
      takeoverTimeoutMs: cur?.takeoverTimeoutMs,
      minutes: cur?.minutes ?? null,
      startedAt: cur?.startedAt ?? null,
      endedAt: cur?.endedAt ?? null,
    }))
    movePhase('recording')
  }, [movePhase])

  const attachRun = useCallback((id: string) => {
    setRunId(id)
    runIdRef.current = id
    stopStreamRef.current = streamBotRun(id, handleEvent, undefined, (msg) => {
      fail(msg)
    })
    const pullComputer = async () => {
      const c = await getBotComputer(id).catch(() => null)
      if (phaseRef.current === 'failed' || phaseRef.current === 'idle') return
      setComputer((prev) => {
        if (!c?.sandboxId) return prev
        const keepUrl = phaseRef.current === 'recording' || phaseRef.current === 'waiting'
        return {
          ...c,
          interactiveUrl: c.interactiveUrl || (keepUrl ? prev?.interactiveUrl ?? null : c.interactiveUrl),
          takeoverRequested: phaseRef.current === 'recording' ? true : c.takeoverRequested,
        }
      })
    }
    void pullComputer()
    if (computerPollRef.current) clearInterval(computerPollRef.current)
    computerPollRef.current = setInterval(() => { void pullComputer() }, 5000)
  }, [handleEvent, fail])

  const start = useCallback(async (teachGoal: string) => {
    const current = phaseRef.current
    if (current === 'recording' || current === 'distilling' || current === 'done' || current === 'starting') return
    if (current === 'waiting' && runIdRef.current) {
      setError('')
      await armRecording(runIdRef.current)
      return
    }
    generationRef.current += 1
    abandoningRef.current = false
    clearTimers()
    distillArmedRef.current = false
    setError('')
    setSkillId(null)
    setSkillName(null)
    setFrames(0)
    setSteps(0)
    movePhase('starting')
    setGoal(teachGoal)
    phaseTimerRef.current = setTimeout(() => {
      if (phaseRef.current === 'starting' || phaseRef.current === 'waiting') {
        void abandon('Timed out waiting for the teach computer. Cancel and try again.')
      }
    }, START_TIMEOUT_MS)
    try {
      const res = await enqueueBotTask({
        goal: teachGoal,
        kind: 'teach',
        maxSteps: 16,
        computer: { enabled: true, ttlMinutes: 30 },
        ...(botId ? { botId } : {}),
        ...(conversationId ? { conversationId } : {}),
      })
      const id = res.task.id
      setTaskId(id)
      taskIdRef.current = id
      pollRef.current = setInterval(async () => {
        try {
          const detail = await getBotTask(id)
          if (phaseRef.current !== 'starting' && phaseRef.current !== 'waiting') return
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
          attachRun(run.id)
          await armRecording(run.id)
        } catch { /* keep polling — worker picks tasks up every few seconds */ }
      }, 2000)
    } catch (err: any) {
      fail(err?.message || 'Could not start the teach session.')
    }
  }, [abandon, armRecording, attachRun, botId, clearTimers, conversationId, fail, movePhase])

  const takeOver = useCallback(async () => {
    const id = runIdRef.current
    if (!id) return
    await armRecording(id)
  }, [armRecording])

  /** Stop ends the recording: release control, distill, wait for skill_saved. */
  const stop = useCallback(async () => {
    const id = runIdRef.current
    if (!id || phaseRef.current !== 'recording') return
    distillArmedRef.current = true
    movePhase('distilling')
    armDistillTimeout()
    try {
      await setBotTakeover(id, false)
    } catch (err: unknown) {
      const message = err instanceof Error && err.message ? err.message : 'Could not release control.'
      setError(message)
    }
    setComputer((cur) => (cur ? { ...cur, takeoverRequested: false } : cur))
  }, [armDistillTimeout, movePhase])

  const cancel = useCallback(async () => {
    await abandon('Teach session cancelled.')
  }, [abandon])

  const reportInput = useCallback((input: TeachOperatorInput) => {
    const id = runIdRef.current
    if (phaseRef.current !== 'recording' || !id) return
    void appendBotTeachStep(id, { at: Date.now(), ...input })
      .then((res) => {
        if (res?.stored === true) setSteps((n) => n + 1)
      })
      .catch((err: unknown) => {
        const message = err instanceof Error && err.message ? err.message : 'Could not record that step.'
        setError(message)
      })
  }, [])

  useEffect(() => {
    return () => {
      const phase = phaseRef.current
      const task = taskIdRef.current
      const run = runIdRef.current
      clearTimers()
      if (phase !== 'starting' && phase !== 'waiting' && phase !== 'recording') return
      if (run) void setBotTakeover(run, false).catch(() => undefined)
      if (task) void cancelBotTask(task).catch(() => undefined)
    }
  }, [clearTimers])

  return {
    phase, goal, taskId, runId, computer, frames, steps, error, skillId, skillName,
    start, takeOver, stop, cancel, reset, reportInput,
  }
}
