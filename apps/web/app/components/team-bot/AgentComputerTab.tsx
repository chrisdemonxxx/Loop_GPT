'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Ghost, Monitor, Loader2, Power, Maximize2, X } from 'lucide-react'
import { getBotBox, wakeBotComputer, setBotTakeover, setBotBoxTakeover, settleBotComputer, sleepBotComputer, recoverBotComputer, resetBotComputer, getBotComputerDisk, BotApiError, type BotBox } from '../../lib/bot'
import type { BotDiskStatus } from '@loop/shared'
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
  /** Open the written trace when Watch cannot show a desktop. */
  onTrace,
  /** Open Files when the disk banner asks to free space. */
  onOpenFiles,
  /** Set when this account cannot start a desktop. Send still works without one. */
  unavailableMessage = null,
}: {
  session: TeachSession
  botName?: string
  onExpand?: () => void
  expanded?: boolean
  onCollapse?: () => void
  autoProbe?: boolean
  runView?: WatchTarget | null
  onTrace?: () => void
  onOpenFiles?: () => void
  unavailableMessage?: string | null
}) {
  const [box, setBox] = useState<BotBox | null>(null)
  const [booting, setBooting] = useState(false)
  const [error, setError] = useState('')
  const [driving, setDriving] = useState(false)
  const [drivenUrl, setDrivenUrl] = useState<string | null>(null)
  const [takeoverBusy, setTakeoverBusy] = useState(false)
  const [disk, setDisk] = useState<BotDiskStatus | null>(null)
  const [pendingAction, setPendingAction] = useState<'recover' | 'reset' | null>(null)
  const [actionBusy, setActionBusy] = useState(false)
  const wakeRef = useRef<() => Promise<void>>(async () => {})

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
          if ((b?.viewUrl || b?.interactiveUrl) && b.alive) {
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
  wakeRef.current = wake

  // Status probe only — never wake on mount (GET must stay side-effect free).
  useEffect(() => {
    if (!autoProbe) return
    void probe()
  }, [autoProbe, probe])

  // Disk while this tab is on screen. Hidden tabs do not poll.
  useEffect(() => {
    if (!box?.alive) return
    let cancelled = false
    const load = () => {
      if (document.visibilityState === 'hidden') return
      void getBotComputerDisk()
        .then((next) => { if (!cancelled) setDisk(next) })
        .catch(() => undefined)
    }
    load()
    const timer = setInterval(load, 60_000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [box?.alive])

  // When the user expands the persistent desktop, trust a fresh status.
  // No view URL means the box is not live — wake, even if an older payload had a URL.
  useEffect(() => {
    if (!expanded || runView || unavailableMessage) return
    let cancelled = false
    void (async () => {
      let fresh: BotBox | null = null
      try {
        fresh = await getBotBox(taskType)
        if (cancelled) return
        setBox(fresh)
      } catch {
        fresh = null
      }
      if (cancelled) return
      if (!fresh?.alive || !fresh.viewUrl) void wakeRef.current()
    })()
    return () => { cancelled = true }
  }, [expanded, runView, taskType, unavailableMessage])

  const teachStream = session.phase === 'starting' || session.phase === 'waiting' || session.phase === 'recording' || session.phase === 'distilling'
  const comp = session.computer
  const watchingRun = !!runView
  const persistentView = box?.alive ? box.viewUrl : null
  const persistentInteractive = box?.alive ? (drivenUrl || box.interactiveUrl) : drivenUrl
  const viewUrl = (teachStream && comp?.viewUrl) || (watchingRun ? runView?.viewUrl : persistentView) || null
  const interactiveUrl = (teachStream && comp?.interactiveUrl) || (watchingRun ? (drivenUrl || runView?.interactiveUrl) : persistentInteractive) || null

  const recording = session.phase === 'recording'
  const inControl = recording || driving || !!(session.phase === 'waiting' && comp?.takeoverRequested)
  const showInteractive = !!(inControl && interactiveUrl)
  const shownUrl = showInteractive ? interactiveUrl : viewUrl
  const streamOpen = Boolean(shownUrl)

  // Bill while a desktop is actually on screen, and once when it leaves.
  useEffect(() => {
    if (!streamOpen) return
    const timer = setInterval(() => {
      void settleBotComputer().catch(() => undefined)
    }, 60_000)
    return () => {
      clearInterval(timer)
      void settleBotComputer().catch(() => undefined)
    }
  }, [streamOpen])

  /** The goal comes from the record bar. A generic sentence is not a demonstration. */
  const startRecording = (goal: string) => {
    const text = goal.trim()
    if (!text) return
    void wake().finally(() => {
      void session.start(text)
    })
  }

  const takeControl = () => {
    setError('')
    if (session.phase === 'waiting' || session.phase === 'starting') {
      void session.takeOver()
      setDriving(true)
      return
    }
    if (watchingRun && runView?.runId) {
      const runId = runView.runId
      setTakeoverBusy(true)
      void setBotTakeover(runId, true)
        .then((res) => {
          if (!res.interactiveUrl) {
            setError('Takeover did not return an interactive stream.')
            return
          }
          setDrivenUrl(res.interactiveUrl)
          setDriving(true)
        })
        .catch((err: unknown) => {
          setError(err instanceof Error && err.message ? err.message : 'Could not take control.')
        })
        .finally(() => setTakeoverBusy(false))
      return
    }
    setTakeoverBusy(true)
    void (async () => {
      try {
        let current = box
        if (!current?.alive || !current.viewUrl) {
          setBooting(true)
          current = await wakeBotComputer(taskType)
          setBox(current)
        }
        if (!current?.alive || !current.viewUrl) {
          setError('Wake the computer before taking control.')
          return
        }
        const res = await setBotBoxTakeover(true)
        if (!res.interactiveUrl) {
          setError('Takeover did not return an interactive stream.')
          return
        }
        setDrivenUrl(res.interactiveUrl)
        setDriving(true)
      } catch (err: unknown) {
        const message = err instanceof Error && err.message ? err.message : 'Could not take control.'
        setError(message)
      } finally {
        setBooting(false)
        setTakeoverBusy(false)
      }
    })()
  }

  const applyBox = (next: BotBox) => {
    setBox(next)
    if (!next.alive) {
      setDriving(false)
      setDrivenUrl(null)
    }
  }

  const sleep = () => {
    setActionBusy(true)
    setError('')
    void sleepBotComputer()
      .then(() => getBotBox(taskType))
      .then(applyBox)
      .catch((err: unknown) => {
        setError(err instanceof Error && err.message ? err.message : 'Could not sleep the computer.')
      })
      .finally(() => setActionBusy(false))
  }

  const confirmAction = () => {
    const action = pendingAction
    if (!action) return
    setPendingAction(null)
    setActionBusy(true)
    setError('')
    const run = action === 'reset' ? resetBotComputer(taskType) : recoverBotComputer(taskType)
    void run
      .then(applyBox)
      .catch((err: unknown) => {
        setError(err instanceof Error && err.message ? err.message : `Could not ${action} the computer.`)
      })
      .finally(() => setActionBusy(false))
  }

  const stopControl = () => {
    setDriving(false)
    setDrivenUrl(null)
    if (session.phase === 'recording') {
      void session.stop()
      return
    }
    if (watchingRun && runView?.runId) {
      const runId = runView.runId
      void setBotTakeover(runId, false).catch((err: unknown) => {
        setError(err instanceof Error && err.message ? err.message : 'Could not release control.')
      })
      return
    }
    void setBotBoxTakeover(false).catch((err: unknown) => {
      setError(err instanceof Error && err.message ? err.message : 'Could not release control.')
    })
  }

  const closeComputer = () => {
    const phase = session.phase
    if (phase === 'starting' || phase === 'waiting' || phase === 'recording') void session.cancel()
    onCollapse?.()
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
          {watchingRun && runView?.noComputer ? (
            <>
              <Monitor size={22} className="text-white/50" aria-hidden />
              <p className="text-ui-sm text-white/80">This bot has no computer — open the trace.</p>
              {onTrace && (
                <button type="button" onClick={onTrace} className="mt-1 px-3 py-1.5 rounded-lg text-ui-xs text-white bg-[var(--accent-fill)] hover:bg-[var(--accent-fill-hover)] transition">
                  Trace
                </button>
              )}
            </>
          ) : watchingRun && runView?.timedOut ? (
            <>
              <Monitor size={22} className="text-white/50" aria-hidden />
              <p className="text-ui-sm text-white/80">The desktop did not come up.</p>
              {onTrace && (
                <button type="button" onClick={onTrace} className="mt-1 px-3 py-1.5 rounded-lg text-ui-xs text-white bg-[var(--accent-fill)] hover:bg-[var(--accent-fill-hover)] transition">
                  Trace
                </button>
              )}
            </>
          ) : watchingRun && !shownUrl ? (
            <>
              <Ghost size={28} className="text-white/80" aria-hidden />
              <p className="text-ui-sm text-white/80">The desktop is starting.</p>
            </>
          ) : unavailableMessage && !watchingRun ? (
            <>
              <Monitor size={22} className="text-white/50" aria-hidden />
              <p className="text-ui-sm text-white/80">A desktop is unavailable.</p>
              <p className="text-ui-xs text-white/60 max-w-sm">{unavailableMessage}</p>
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
              <p className="text-ui-sm text-white/70">{box?.paused ? 'The computer is paused.' : box?.alive ? 'Stream offline — wake to reconnect.' : 'The computer is asleep.'}</p>
              <button type="button" onClick={() => void wake()} className="mt-1 flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-ui-xs text-white bg-[var(--accent-fill)] hover:bg-[var(--accent-fill-hover)] transition">
                <Power size={12} aria-hidden /> Wake the computer
              </button>
            </>
          )}
        </div>
      )}

      {shownUrl && error && (
        <p className="absolute top-2 left-2 right-10 z-20 text-center text-ui-xs text-[var(--danger)]">{error}</p>
      )}

      {shownUrl && (
        <ControlPill
          driving={inControl}
          takeDisabled={takeoverBusy || (!viewUrl && session.phase !== 'waiting' && session.phase !== 'starting')}
          onTakeControl={takeControl}
          onStop={stopControl}
        />
      )}

      {!expanded && onExpand && (
        <button
          type="button"
          onClick={onExpand}
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
          <ComputerActions
            alive={Boolean(box?.alive && box.viewUrl)}
            busy={actionBusy || booting}
            pending={pendingAction}
            diskWarn={Boolean(disk?.warn)}
            onSleep={sleep}
            onAsk={setPendingAction}
            onConfirm={confirmAction}
            onCancel={() => setPendingAction(null)}
            onOpenFiles={onOpenFiles}
          />
          {session.error && (
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
        onClose={closeComputer}
        ariaLabel={`${botName}'s computer`}
        scrimClassName="bg-[var(--bg-base)] !p-0"
        panelClassName="w-full h-full rounded-none border-none bg-[var(--bg-base)] p-0 shadow-none outline-none flex flex-col"
      >
        <RecordBar
          session={session}
          botName={botName}
          onStart={startRecording}
          onStop={stopControl}
          onDiscard={() => { void session.cancel() }}
          onClose={closeComputer}
        />
        <ComputerActions
          alive={Boolean(box?.alive && (box.viewUrl || runView?.viewUrl))}
          busy={actionBusy || booting}
          pending={pendingAction}
          diskWarn={Boolean(disk?.warn)}
          onSleep={sleep}
          onAsk={setPendingAction}
          onConfirm={confirmAction}
          onCancel={() => setPendingAction(null)}
          onOpenFiles={onOpenFiles}
        />
        {stage}
      </Dialog>
    )
  }

  return stage
}

function ComputerActions({
  alive, busy, pending, diskWarn, onSleep, onAsk, onConfirm, onCancel, onOpenFiles,
}: {
  alive: boolean
  busy: boolean
  pending: 'recover' | 'reset' | null
  diskWarn: boolean
  onSleep: () => void
  onAsk: (action: 'recover' | 'reset') => void
  onConfirm: () => void
  onCancel: () => void
  onOpenFiles?: () => void
}) {
  return (
    <div className="mt-2 flex flex-col items-center gap-2">
      {diskWarn && (
        <div role="status" className="w-full rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-hover)] px-3 py-2 text-left">
          <p className="text-ui-xs text-[var(--ink-primary)]">The computer is low on disk space.</p>
          {onOpenFiles && (
            <button type="button" onClick={onOpenFiles} className="mt-1 min-h-8 px-2 text-ui-xs text-[var(--accent-text)] hover:underline">
              Free up space
            </button>
          )}
        </div>
      )}
      <div className="flex flex-wrap items-center justify-center gap-2">
        {alive && (
          <button type="button" onClick={onSleep} disabled={busy} className="min-h-8 px-3 rounded-lg text-ui-xs text-[var(--ink-secondary)] hover:text-[var(--ink-primary)] hover:bg-[var(--bg-hover)] transition disabled:opacity-40">
            Sleep
          </button>
        )}
        <button type="button" onClick={() => onAsk('recover')} disabled={busy} className="min-h-8 px-3 rounded-lg text-ui-xs text-[var(--ink-secondary)] hover:text-[var(--ink-primary)] hover:bg-[var(--bg-hover)] transition disabled:opacity-40">
          Recover computer
        </button>
        <button type="button" onClick={() => onAsk('reset')} disabled={busy} className="min-h-8 px-3 rounded-lg text-ui-xs text-[var(--ink-secondary)] hover:text-[var(--danger)] hover:bg-[var(--bg-hover)] transition disabled:opacity-40">
          Reset computer
        </button>
      </div>
      {pending && (
        <div role="dialog" aria-label={pending === 'reset' ? 'Reset the computer' : 'Recover the computer'} className="w-full rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-base)] px-3 py-2 text-left">
          <p className="text-ui-xs text-[var(--ink-secondary)]">
            {pending === 'reset'
              ? 'Reset rolls the desktop back to the last snapshot. Files that were not in that snapshot can be lost.'
              : 'Recover restarts the desktop. Saved files and logins stay.'}
          </p>
          <div className="mt-2 flex gap-2">
            <button type="button" onClick={onCancel} className="min-h-8 px-3 rounded-lg text-ui-xs text-[var(--ink-secondary)] hover:bg-[var(--bg-hover)] transition">
              Cancel
            </button>
            <button type="button" onClick={onConfirm} className="min-h-8 px-3 rounded-lg text-ui-xs font-medium text-white bg-[var(--accent-fill)] hover:bg-[var(--accent-fill-hover)] transition">
              {pending === 'reset' ? 'Reset computer' : 'Recover computer'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
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
  session, botName, onStart, onStop, onDiscard, onClose,
}: {
  session: TeachSession
  botName: string
  onStart: (goal: string) => void
  onStop: () => void
  onDiscard: () => void
  onClose?: () => void
}) {
  const [demo, setDemo] = useState('')
  const recording = session.phase === 'recording'
  const canDiscard = session.phase === 'starting' || session.phase === 'waiting' || session.phase === 'recording'
  const begin = () => {
    const goal = demo.trim()
    if (!goal) return
    onStart(goal)
  }
  return (
    <div className="flex items-center gap-3 px-4 py-3 border-b border-[var(--border-subtle)] shrink-0">
      {recording ? (
        <>
          <span className="w-2 h-2 rounded-full bg-[var(--danger)] animate-pulse shrink-0" aria-hidden />
          <span className="text-ui-sm text-[var(--ink-primary)]">
            {session.frames} {session.frames === 1 ? 'frame' : 'frames'} · {session.steps} {session.steps === 1 ? 'step' : 'steps'}
          </span>
          {session.error && <span className="min-w-0 truncate text-ui-xs text-[var(--danger)]">{session.error}</span>}
          <button
            type="button"
            onClick={onDiscard}
            className="ml-auto px-3 py-1.5 rounded-lg text-ui-xs text-[var(--ink-secondary)] hover:bg-[var(--bg-hover)] transition"
          >
            Discard
          </button>
          <button
            type="button"
            onClick={onStop}
            className="px-3 py-1.5 rounded-lg text-ui-xs font-medium text-white bg-[var(--danger-strong)] hover:bg-[var(--danger-strong-hover)] transition"
          >
            Stop
          </button>
        </>
      ) : (
        <>
          {session.phase === 'failed' || session.phase === 'distilling' || session.phase === 'done' ? (
            <p className={`flex-1 min-w-0 text-ui-sm leading-snug ${session.phase === 'failed' ? 'text-[var(--danger)]' : 'text-[var(--ink-secondary)]'}`}>
              {session.phase === 'failed'
                ? session.error
                : session.phase === 'distilling'
                  ? 'Saving skill…'
                  : `Skill saved${session.skillName ? ` · ${session.skillName}` : ''}`}
            </p>
          ) : (
            <input
              value={demo}
              onChange={(e) => setDemo(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); begin() } }}
              placeholder={`What should ${botName} learn?`}
              aria-label="What are you demonstrating?"
              disabled={session.phase === 'starting'}
              className="flex-1 min-w-0 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-base)] px-2.5 py-1.5 text-ui-sm text-[var(--ink-primary)] placeholder:text-[var(--ink-muted)] focus:border-[var(--accent-soft-border)] focus:outline-none disabled:opacity-60"
            />
          )}
          {session.phase === 'distilling' ? (
            <Loader2 size={16} className="animate-spin text-[var(--accent-text)] shrink-0" aria-hidden />
          ) : session.phase === 'done' || session.phase === 'failed' ? null : (
            <>
              {canDiscard && (
                <button
                  type="button"
                  onClick={onDiscard}
                  className="shrink-0 px-3 py-1.5 rounded-lg text-ui-xs text-[var(--ink-secondary)] hover:bg-[var(--bg-hover)] transition"
                >
                  Discard
                </button>
              )}
              <button
                type="button"
                onClick={begin}
                disabled={session.phase === 'starting' || !demo.trim()}
                className="shrink-0 px-3 py-1.5 rounded-lg text-ui-xs font-medium text-white bg-[var(--danger-strong)] hover:bg-[var(--danger-strong-hover)] transition disabled:opacity-60"
              >
                {session.phase === 'starting' ? 'Starting…' : 'Start recording'}
              </button>
            </>
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
