'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Monitor, Loader2, MousePointer2, Square, RefreshCw, Power, Maximize2, X, Circle, GraduationCap } from 'lucide-react'
import { getBotBox, BotApiError, type BotBox } from '../../lib/bot'
import { Dialog } from '@loop/ui'
import type { TeachSession } from './useTeachSession'

/**
 * The agent's persistent computer, two presentations of the same stream:
 *
 *  - embedded (Computer tab in the profile panel): small live screen with an
 *    ⤢ expand button — Grok's "create bot" panel view.
 *  - expanded (onExpand → shared Dialog, full-bleed): the screen enlarges to
 *    fill the window; header carries the "⏺ Teach a task" pill and the
 *    collapse ✕ — Grok's full-desktop view. Teach simply starts recording
 *    the human's workflow inside the computer (one click). Escape collapses.
 */
export function AgentComputerTab({
  session,
  onExpand,
  expanded = false,
  onCollapse,
}: {
  session: TeachSession
  onExpand?: () => void
  expanded?: boolean
  onCollapse?: () => void
}) {
  const [box, setBox] = useState<BotBox | null>(null)
  const [booting, setBooting] = useState(false)
  const [error, setError] = useState('')
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const boot = useCallback(async () => {
    setBooting(true); setError('')
    try {
      const b = await getBotBox(session.phase === 'recording' || session.phase === 'waiting' ? 'teach' : 'default')
      setBox(b)
    } catch (err: any) {
      if (err instanceof BotApiError && err.status === 404) {
        setError('This backend does not have persistent boxes yet — the deployment is still rolling out. Retry in a minute.')
      } else if (err instanceof BotApiError && (err.status === 503 || /E2B/i.test(err.message || ''))) {
        setError('The computer provider is not configured on this deployment (E2B_API_KEY missing).')
      } else {
        setError(err?.message || 'Could not boot the bot computer.')
      }
    } finally {
      setBooting(false)
    }
  }, [session.phase])

  useEffect(() => {
    void boot()
    pollRef.current = setInterval(() => void boot(), 60_000)
    return () => { if (pollRef.current) clearInterval(pollRef.current) }
  }, [boot])

  const teachActive = session.phase === 'waiting' || session.phase === 'recording'
  const comp = session.computer
  const viewUrl = teachActive && comp?.viewUrl ? comp.viewUrl : box?.viewUrl || null
  const interactiveUrl = teachActive && comp?.interactiveUrl ? comp.interactiveUrl : (box?.interactiveUrl || null)
  // Embedded = watch (view-only); expanded = drive (interactive). During a
  // teach takeover the interactive layer always wins.
  const showInteractive =
    (teachActive && comp?.takeoverRequested && interactiveUrl) ||
    (!teachActive && expanded && interactiveUrl)
  const shownUrl = showInteractive ? interactiveUrl : viewUrl

  /** One click: boot the box and start recording the operator's workflow. */
  const startTeach = () => {
    void session.start('Watch the operator demonstrate a workflow on this computer and learn it as a reusable skill.')
  }

  const screen = (
    <>
      {/* Screen */}
      <div className="relative flex-1 min-h-0 bg-black">
        {shownUrl ? (
          <iframe
            key={shownUrl}
            src={shownUrl}
            title="Loop Bot computer"
            className="absolute inset-0 w-full h-full border-0"
            allow="clipboard-read; clipboard-write"
          />
        ) : (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2.5 text-center px-6">
            {booting ? (
              <>
                <LoadingDots />
                <p className="text-ui-sm text-[var(--ink-secondary)]">{box?.resumed === false ? 'Starting desktop' : 'Waking the bot computer…'}</p>
              </>
            ) : error ? (
              <>
                <Monitor size={22} className="text-[var(--ink-muted)]" aria-hidden />
                <p className="text-ui-sm text-[var(--danger)] max-w-sm">{error}</p>
                <button type="button" onClick={() => void boot()} className="mt-1 flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-ui-xs text-white bg-[var(--accent-fill)] hover:bg-[var(--accent-fill-hover)] transition">
                  <Power size={12} aria-hidden /> Boot the computer
                </button>
              </>
            ) : (
              <>
                <Monitor size={22} className="text-[var(--ink-muted)]" aria-hidden />
                <p className="text-ui-sm text-[var(--ink-secondary)]">The computer is off.</p>
                <button type="button" onClick={() => void boot()} className="mt-1 flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-ui-xs text-white bg-[var(--accent-fill)] hover:bg-[var(--accent-fill-hover)] transition">
                  <Power size={12} aria-hidden /> Boot the computer
                </button>
              </>
            )}
          </div>
        )}

        {/* Teach overlays */}
        {session.phase === 'waiting' && (
          <div className="absolute inset-x-0 bottom-0 p-3 bg-gradient-to-t from-black/85 to-transparent">
            <div className="flex items-center gap-3 rounded-xl border border-[var(--border-strong)] bg-[var(--bg-overlay)] px-3.5 py-2.5">
              <MousePointer2 size={14} className="text-[var(--warning)] shrink-0" aria-hidden />
              <div className="flex-1 min-w-0">
                <p className="text-ui-sm text-[var(--ink-primary)]">Ready when you are — take over and show the bot how it&apos;s done.</p>
                <p className="text-2xs text-[var(--ink-muted)]">It records your screen until you press Stop.</p>
              </div>
              <button type="button" onClick={() => void session.takeOver()} className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-ui-xs font-medium text-white bg-[var(--accent-fill)] hover:bg-[var(--accent-fill-hover)] transition">
                <MousePointer2 size={12} aria-hidden /> Take over
              </button>
            </div>
          </div>
        )}
        {session.phase === 'recording' && (
          <div className="absolute inset-x-0 bottom-0 p-3 bg-gradient-to-t from-black/85 to-transparent">
            <div className="flex items-center gap-3 rounded-xl border border-[var(--danger-soft-border)] bg-[var(--danger-soft)] px-3.5 py-2.5">
              <span className="w-2 h-2 rounded-full bg-[var(--danger)] animate-pulse shrink-0" aria-hidden />
              <p className="flex-1 text-ui-sm text-[var(--ink-primary)]">Recording — drive the computer; the bot is watching.</p>
              <button type="button" onClick={() => void session.stop()} className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-ui-xs font-medium text-white bg-[var(--danger-strong)] hover:bg-[var(--danger-strong-hover)] transition">
                <Square size={11} aria-hidden /> Stop
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Status strip */}
      <div className="flex items-center gap-2 px-3 py-2 border-t border-[var(--border-subtle)] text-2xs text-[var(--ink-muted)] shrink-0">
        <span className={`w-1.5 h-1.5 rounded-full ${box?.alive ? 'bg-[var(--success)]' : 'bg-[var(--ink-muted)]'}`} aria-hidden />
        <span className="font-mono truncate">{box?.sandboxId ? `loop-bot-vm-${box.sandboxId.slice(0, 8)}` : 'loop-bot-vm'}</span>
        <span className="opacity-50">·</span>
        <span>{box?.alive ? (box.resumed ? 'resumed' : 'always on') : booting ? 'booting…' : 'off'}</span>
        <span className="ml-auto font-mono opacity-50">{box?.workspaceDir || '/workspace'}</span>
        <button type="button" onClick={() => void boot()} aria-label="Refresh the stream" className="p-1 rounded text-[var(--ink-muted)] hover:text-[var(--ink-secondary)] hover:bg-[var(--bg-hover)] transition">
          <RefreshCw size={12} aria-hidden />
        </button>
      </div>
    </>
  )

  // ── Expanded: full-window Dialog with teach pill + collapse ─────────────
  if (expanded) {
    return (
      <Dialog
        open
        onClose={() => { onCollapse?.() }}
        ariaLabel="Loop Bot computer"
        scrimClassName="bg-[var(--bg-base)] !p-0"
        panelClassName="w-full h-full rounded-none border-none bg-[var(--bg-base)] p-0 shadow-none outline-none flex flex-col"
      >
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-[var(--border-subtle)] shrink-0">
          <Monitor size={15} className="text-[var(--ink-muted)]" aria-hidden />
          <span className="text-ui-sm font-medium text-[var(--ink-secondary)]">Loop Bot&apos;s computer</span>
          <div className="ml-auto flex items-center gap-2">
            <TeachPill session={session} onStart={startTeach} />
            <button
              type="button"
              onClick={onCollapse}
              aria-label="Shrink the computer view"
              className="p-2 rounded-lg text-[var(--ink-muted)] hover:text-[var(--ink-secondary)] hover:bg-[var(--bg-hover)] transition"
            >
              <X size={16} aria-hidden />
            </button>
          </div>
        </div>
        {screen}
      </Dialog>
    )
  }

  // ── Embedded: small stream + expand button ─────────────────────────────────
  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-[var(--border-subtle)] shrink-0">
        <span className="text-ui-xs text-[var(--ink-secondary)] font-medium">Its screen — live</span>
        <div className="ml-auto flex items-center gap-1">
          <TeachPill session={session} onStart={startTeach} compact />
          {onExpand && (
            <button
              type="button"
              onClick={onExpand}
              aria-label="Enlarge the computer view"
              title="Enlarge"
              className="p-1.5 rounded-lg text-[var(--ink-muted)] hover:text-[var(--ink-secondary)] hover:bg-[var(--bg-hover)] transition"
            >
              <Maximize2 size={13} aria-hidden />
            </button>
          )}
        </div>
      </div>
      {screen}
    </div>
  )
}

/** The record-dot teach pill — one click starts recording, one click stops. */
function TeachPill({ session, onStart, compact = false }: { session: TeachSession; onStart: () => void; compact?: boolean }) {
  const { phase, frames, error } = session
  const base = compact ? 'px-2 py-1 text-2xs gap-1' : 'px-3 py-1.5 text-ui-xs gap-1.5'

  if (phase === 'starting' || phase === 'waiting') {
    return (
      <span className={`flex items-center rounded-lg font-medium text-[var(--danger)] bg-[var(--danger-soft)] border border-[var(--danger-soft-border)] ${base}`}>
        <Loader2 size={compact ? 10 : 12} className="animate-spin" aria-hidden />
        {phase === 'starting' ? 'Booting…' : 'Take over'}
      </span>
    )
  }
  if (phase === 'recording') {
    return (
      <button
        type="button"
        onClick={() => void session.stop()}
        className={`flex items-center rounded-lg font-medium text-white bg-[var(--danger-strong)] hover:bg-[var(--danger-strong-hover)] transition ${base}`}
        title="Stop — the bot converts the recording into a skill"
      >
        <Square size={compact ? 9 : 11} className="fill-current" aria-hidden />
        Stop{!compact && ` · ${frames}f`}
      </button>
    )
  }
  if (phase === 'distilling') {
    return (
      <span className={`flex items-center rounded-lg font-medium text-[var(--accent-text)] bg-[var(--accent-soft)] border border-[var(--accent-soft-border)] ${base}`}>
        <Loader2 size={compact ? 10 : 12} className="animate-spin" aria-hidden /> Saving skill…
      </span>
    )
  }
  if (phase === 'done') {
    return (
      <span className={`flex items-center rounded-lg font-medium text-[var(--success)] bg-[var(--bg-tint)] border border-[var(--border-subtle)] ${base}`}>
        <GraduationCap size={compact ? 10 : 12} aria-hidden /> Skill saved
      </span>
    )
  }
  if (phase === 'failed') {
    return (
      <button type="button" onClick={session.reset} title={error} className={`flex items-center rounded-lg font-medium text-[var(--danger)] bg-[var(--danger-soft)] border border-[var(--danger-soft-border)] ${base}`}>
        Retry
      </button>
    )
  }
  return (
    <button
      type="button"
      onClick={onStart}
      title="Start recording — drive the computer through the task once and it becomes a skill"
      className={`flex items-center rounded-lg font-medium text-[var(--ink-secondary)] bg-[var(--bg-hover-strong)] border border-[var(--border-strong)] hover:bg-[var(--bg-hover)] transition ${base}`}
    >
      <Circle size={compact ? 8 : 10} className="fill-[var(--danger)] text-[var(--danger)]" aria-hidden />
      Teach a task
    </button>
  )
}

/** Grok's "Starting desktop" three-dot loader. */
function LoadingDots() {
  return (
    <div className="flex items-center gap-1.5" aria-hidden>
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="w-2 h-2 rounded-full bg-[var(--ink-muted)] animate-bounce"
          style={{ animationDelay: `${i * 0.15}s`, animationDuration: '0.9s' }}
        />
      ))}
    </div>
  )
}
