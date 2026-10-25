'use client'

import { useCallback, useEffect, useState } from 'react'
import { Ghost, Monitor, Loader2, Power, Maximize2, X } from 'lucide-react'
import { getBotBox, wakeBotComputer, BotApiError, type BotBox } from '../../lib/bot'
import { Dialog } from '@loop/ui'
import { BotScreen } from './BotScreen'
import type { WatchTarget } from '../../agents/botTask'
import type { TeachSession } from './useTeachSession'

const COMPUTER_UNREACHABLE = 'The computer could not be reached. Retry in a minute.'

/**
 * The agent's persistent computer.
 *
 * Embedded and expanded, the stage is the 16:9 frame itself: edge to edge
 * in the pane, with no taller black box around a smaller screen. The caption
 * sits under the embedded frame. Expanded adds the record bar.
 *
 * Stop on the pill releases control. While a recording is active, Stop ends
 * the recording and distills — it does not save a skill on the first click.
 */
export function AgentComputerTab({
  session,
  botName = 'Loop Bot',
  onExpand,
  expanded = false,
  onCollapse,
  /** When false, skip the initial status probe (parent already owns wake). */
  autoProbe = true,
  /** Set while Watch is showing this run's desktop. Absent on the persistent Computer tab. */
  runView = null,
}: {
  session: TeachSession
  botName?: string
  onExpand?: () => void
  expanded?: boolean
  onCollapse?: () => void
  autoProbe?: boolean
  runView?: WatchTarget | null
}) {
  const [box, setBox] = useState<BotBox | null>(null)
  const [booting, setBooting] = useState(false)
  const [error, setError] = useState('')
  const [driving, setDriving] = useState(false)

  const taskType = session.phase === 'recording' || session.phase === 'waiting' ? 'teach' as const : 'default' as const

  const probe = useCallback(async () => {
    setError('')
    try {
      const b = await getBotBox(taskType)
      setBox(b)
    } catch (err: any) {
      if (err instanceof BotApiError && err.status === 404) {
        setError(COMPUTER_UNREACHABLE)
      } else {
        setError(err?.message || 'Could not read the bot computer status.')
      }
    }
  }, [taskType])

  const wake = useCallback(async () => {
    setBooting(true)
    setError('')
    try {
      const b = await wakeBotComputer(taskType)
      setBox(b)
    } catch (err: any) {
      if (err instanceof BotApiError && (err.status === 404 || err.status === 402)) {
        // 404: wake not deployed yet. 402: quota exhausted but an already-alive
        // box may still stream — fall back to status GET.
        try {
          const b = await getBotBox(taskType)
          if (b?.viewUrl || b?.interactiveUrl || b?.alive) {
            setBox(b)
            if (err.status === 402) {
              setError('Daily computer minutes are used up — showing the existing desktop if it is still awake.')
            }
            return
          }
        } catch (fallbackErr: any) {
          err = fallbackErr
        }
      }
      if (err instanceof BotApiError && err.status === 404) {
        setError(COMPUTER_UNREACHABLE)
      } else if (err instanceof BotApiError && err.status === 402) {
        setError(err.message || "Today's dedicated-computer budget is used up. It resets with your daily credits.")
      } else if (err instanceof BotApiError && (err.status === 503 || /E2B/i.test(err.message || ''))) {
        setError('The computer provider is not configured on this deployment (E2B_API_KEY missing).')
      } else {
        setError(err?.message || 'Could not wake the bot computer.')
      }
    } finally {
      setBooting(false)
    }
  }, [taskType])

  // Status probe only — never wake on mount (GET must stay side-effect free).
  useEffect(() => {
    if (!autoProbe) return
    void probe()
  }, [autoProbe, probe])

  // When the user expands, wake if we don't have a stream yet.
  useEffect(() => {
    if (!expanded || runView) return
    if (box?.viewUrl || box?.interactiveUrl) return
    void wake()
  }, [expanded, runView]) // eslint-disable-line react-hooks/exhaustive-deps -- wake once on expand of the persistent box

  const teachStream = session.phase === 'starting' || session.phase === 'waiting' || session.phase === 'recording' || session.phase === 'distilling'
  const comp = session.computer
  const watchingRun = !!runView
  const viewUrl = (teachStream && comp?.viewUrl) || (watchingRun ? runView?.viewUrl : box?.viewUrl) || null
  const interactiveUrl = (teachStream && comp?.interactiveUrl) || (watchingRun ? runView?.interactiveUrl : box?.interactiveUrl) || null

  const recording = session.phase === 'recording'
  const inControl = recording || driving || !!(session.phase === 'waiting' && comp?.takeoverRequested)
  const showInteractive = !!(inControl && interactiveUrl)
  const shownUrl = showInteractive ? interactiveUrl : viewUrl

  /** Enqueue a teach run if needed, take over, and record. Does not save a skill. */
  const startRecording = () => {
    void wake().finally(() => {
      void session.start('Watch the operator demonstrate a workflow on this computer and learn it as a reusable skill.')
    })
  }

  const takeControl = () => {
    if (session.phase === 'waiting' || session.phase === 'starting') void session.takeOver()
    setDriving(true)
  }

  const stopControl = () => {
    setDriving(false)
    if (session.phase === 'recording') void session.stop()
  }

  const screen = (
    <div className="absolute inset-0">
      {shownUrl ? (
        <BotScreen
          key={`${shownUrl}:${showInteractive ? 'i' : 'v'}`}
          url={shownUrl}
          interactive={!!showInteractive}
          onOperatorInput={recording && showInteractive ? session.reportInput : undefined}
        />
      ) : (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2.5 text-center px-6 bg-black">
          {watchingRun && !shownUrl ? (
            <>
              <Ghost size={28} className="text-white/80" aria-hidden />
              <p className="text-ui-sm text-white/80">The desktop is starting.</p>
            </>
          ) : booting || session.phase === 'starting' ? (
            <>
              <Ghost size={28} className="text-white/80" aria-hidden />
              <p className="text-ui-sm text-white/80">Waking up…</p>
            </>
          ) : error ? (
            <>
              <Monitor size={22} className="text-white/50" aria-hidden />
              <p className="text-ui-sm text-[var(--danger)] max-w-sm">{error}</p>
              <button type="button" onClick={() => void wake()} className="mt-1 flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-ui-xs text-white bg-[var(--accent-fill)] hover:bg-[var(--accent-fill-hover)] transition">
                <Power size={12} aria-hidden /> Wake the computer
              </button>
            </>
          ) : (
            <>
              <Monitor size={22} className="text-white/50" aria-hidden />
              <p className="text-ui-sm text-white/70">{box?.alive ? 'Stream offline — wake to reconnect.' : 'The computer is asleep.'}</p>
              <button type="button" onClick={() => void wake()} className="mt-1 flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-ui-xs text-white bg-[var(--accent-fill)] hover:bg-[var(--accent-fill-hover)] transition">
                <Power size={12} aria-hidden /> Wake the computer
              </button>
            </>
          )}
        </div>
      )}

      {shownUrl && (
        <ControlPill
          driving={inControl}
          takeDisabled={!interactiveUrl && session.phase !== 'waiting'}
          onTakeControl={takeControl}
          onStop={stopControl}
        />
      )}

      {!expanded && onExpand && (
        <button
          type="button"
          onClick={() => { onExpand(); if (!box?.viewUrl) void wake() }}
          aria-label="Enlarge the computer view"
          title="Enlarge"
          className="absolute top-2 right-2 z-20 p-1.5 rounded-lg text-white/70 hover:text-white hover:bg-white/10 transition"
        >
          <Maximize2 size={14} aria-hidden />
        </button>
      )}
    </div>
  )

  const frame = expanded ? (
    <div className="relative flex-1 min-h-0 w-full">
      {/* Transparent fit box. The black 16:9 element is the stage. */}
      <div className="absolute inset-0" style={{ containerType: 'size' }}>
        <div
          className="absolute top-0 left-1/2 -translate-x-1/2 aspect-video overflow-hidden bg-black"
          style={{ width: 'min(100cqw, calc(100cqh * 16 / 9))', height: 'min(100cqh, calc(100cqw * 9 / 16))' }}
        >
          {screen}
        </div>
      </div>
    </div>
  ) : (
    <div className="relative w-full aspect-video overflow-hidden bg-black">
      {screen}
    </div>
  )

  const stage = (
    <div className={`flex flex-col min-h-0 w-full ${expanded ? 'flex-1' : ''}`}>
      {frame}
      {!expanded && (
        <div className="shrink-0 px-4 pt-2 text-center">
          <p className="text-ui-xs text-[var(--ink-muted)]">{botName}&apos;s screen</p>
          <p className="mt-1 text-2xs text-[var(--ink-muted)]">This desktop is shared across your bots.</p>
          {session.phase === 'failed' && session.error && (
            <p className="mt-1 text-ui-xs text-[var(--danger)]">{session.error}</p>
          )}
          {session.phase === 'done' && (
            <p className="mt-1 text-ui-xs text-[var(--success)]">
              Skill saved{session.skillName ? ` · ${session.skillName}` : ''}
            </p>
          )}
        </div>
      )}
    </div>
  )

  if (expanded) {
    return (
      <Dialog
        open
        onClose={() => { onCollapse?.() }}
        ariaLabel={`${botName}'s computer`}
        scrimClassName="bg-[var(--bg-base)] !p-0"
        panelClassName="w-full h-full rounded-none border-none bg-[var(--bg-base)] p-0 shadow-none outline-none flex flex-col"
      >
        <RecordBar
          session={session}
          botName={botName}
          onStart={startRecording}
          onStop={stopControl}
          onClose={onCollapse}
        />
        {stage}
      </Dialog>
    )
  }

  return stage
}

/** On-screen pill. Stop releases control, and ends the recording when one is active. */
function ControlPill({
  driving, takeDisabled, onTakeControl, onStop,
}: {
  driving: boolean
  takeDisabled?: boolean
  onTakeControl: () => void
  onStop: () => void
}) {
  return (
    <div className="absolute bottom-3 left-1/2 -translate-x-1/2 z-20 flex items-center gap-1 rounded-full bg-black/75 border border-white/15 pl-3 pr-1 py-1 shadow-lg">
      {driving ? (
        <>
          <span className="text-ui-xs text-white pr-1">You&apos;re in control</span>
          <button
            type="button"
            onClick={onStop}
            className="rounded-full bg-white text-black px-3 py-1 text-ui-xs font-medium hover:bg-white/90 transition"
          >
            Stop
          </button>
        </>
      ) : (
        <>
          <span className="text-ui-xs text-white/80 pr-1">Watching</span>
          <button
            type="button"
            onClick={onTakeControl}
            disabled={takeDisabled}
            className="rounded-full bg-white text-black px-3 py-1 text-ui-xs font-medium hover:bg-white/90 transition disabled:opacity-40"
          >
            Take control
          </button>
        </>
      )}
    </div>
  )
}

function RecordBar({
  session, botName, onStart, onStop, onClose,
}: {
  session: TeachSession
  botName: string
  onStart: () => void
  onStop: () => void
  onClose?: () => void
}) {
  const recording = session.phase === 'recording'
  return (
    <div className="flex items-center gap-3 px-4 py-3 border-b border-[var(--border-subtle)] shrink-0">
      {recording ? (
        <>
          <span className="w-2 h-2 rounded-full bg-[var(--danger)] animate-pulse shrink-0" aria-hidden />
          <span className="text-ui-sm text-[var(--ink-primary)]">
            {session.frames} {session.frames === 1 ? 'frame' : 'frames'} · {session.steps} {session.steps === 1 ? 'step' : 'steps'}
          </span>
          <button
            type="button"
            onClick={onStop}
            className="ml-auto px-3 py-1.5 rounded-lg text-ui-xs font-medium text-white bg-[var(--danger-strong)] hover:bg-[var(--danger-strong-hover)] transition"
          >
            Stop
          </button>
        </>
      ) : (
        <>
          <p className={`flex-1 min-w-0 text-ui-sm leading-snug ${session.phase === 'failed' ? 'text-[var(--danger)]' : 'text-[var(--ink-secondary)]'}`}>
            {session.phase === 'failed'
              ? session.error
              : session.phase === 'distilling'
                ? 'Saving skill…'
                : session.phase === 'done'
                  ? `Skill saved${session.skillName ? ` · ${session.skillName}` : ''}`
                  : `Record yourself doing a task. ${botName} learns the steps and can run them again on its own.`}
          </p>
          {session.phase === 'distilling' ? (
            <Loader2 size={16} className="animate-spin text-[var(--accent-text)] shrink-0" aria-hidden />
          ) : session.phase === 'done' ? null : (
            <button
              type="button"
              onClick={onStart}
              disabled={session.phase === 'starting'}
              className="shrink-0 px-3 py-1.5 rounded-lg text-ui-xs font-medium text-white bg-[var(--danger-strong)] hover:bg-[var(--danger-strong-hover)] transition disabled:opacity-60"
            >
              {session.phase === 'starting' ? 'Starting…' : 'Start recording'}
            </button>
          )}
        </>
      )}
      <button
        type="button"
        onClick={onClose}
        aria-label="Close the computer view"
        className="p-2 rounded-lg text-[var(--ink-muted)] hover:text-[var(--ink-secondary)] hover:bg-[var(--bg-hover)] transition shrink-0"
      >
        <X size={16} aria-hidden />
      </button>
    </div>
  )
}
