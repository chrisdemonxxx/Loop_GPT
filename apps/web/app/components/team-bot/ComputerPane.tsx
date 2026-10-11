'use client'

import { useState } from 'react'
import { Hand, MonitorOff } from 'lucide-react'
import { setBotTakeover } from '../../lib/bot'
import type { BotComputer } from '../../lib/bot'
import { ConfirmDialog } from '@loop/ui'

/**
 * team-bot computer pane (sand's computer-screen-preview + takeover
 * handshake): sandbox metadata bar, takeover banner, the noVNC stream, and
 * the always-confirm takeover dialog.
 *
 * The iframe is only rendered while the session is ACTIVE. A finished run
 * destroys its dedicated VM, and framing the dead host used to render a
 * black pane under a pulsing LIVE badge — the offline state says what
 * happened instead.
 */
export function ComputerPane({
  runId, computer, setComputer,
}: {
  runId: string | null
  computer: BotComputer
  setComputer: React.Dispatch<React.SetStateAction<BotComputer | null>>
}) {
  const [confirmTakeover, setConfirmTakeover] = useState(false)
  const [takeoverBusy, setTakeoverBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  const takeover = async (seize: boolean) => {
    if (!runId) return
    setTakeoverBusy(true)
    setActionError(null)
    try {
      const r = await setBotTakeover(runId, seize)
      setComputer((cur) => cur ? { ...cur, takeoverRequested: r.takeoverRequested, interactiveUrl: r.interactiveUrl } : cur)
      setConfirmTakeover(false)
    } catch (err: any) {
      // e.g. 409 on a finished run — the dialog must close and the user must
      // hear about it; swallowing the error left the UI stuck on "working".
      setConfirmTakeover(false)
      setActionError(err?.message || 'Takeover failed — the run may already be finished.')
    } finally {
      setTakeoverBusy(false)
    }
  }

  const timeoutMinutes = Math.round((computer.takeoverTimeoutMs || 30 * 60_000) / 60_000)

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="shrink-0 flex items-center gap-2 px-3 py-2 text-2xs text-[var(--ink-muted)] border-b border-[var(--border-subtle)]">
        <span className={`w-1.5 h-1.5 rounded-full ${computer.active ? 'bg-[var(--success)]' : 'bg-[var(--ink-muted)]'}`} aria-hidden />
        <span className="font-mono truncate">{computer.sandboxId}</span>
        {computer.minutes != null && <span className="ml-auto tabular-nums">{computer.minutes} min</span>}
        {computer.active && !computer.takeoverRequested && (
          <button
            type="button"
            onClick={() => setConfirmTakeover(true)}
            className="flex items-center gap-1 px-2 py-1 rounded-lg bg-[var(--bg-hover)] text-[var(--ink-secondary)] hover:bg-[var(--bg-hover-strong)] transition"
          >
            <Hand size={11} aria-hidden /> Take over
          </button>
        )}
      </div>

      {computer.takeoverRequested && (
        <div className="shrink-0 flex items-center gap-2 px-3 py-2 bg-[var(--bg-tint)] border-b border-[var(--border-subtle)] text-ui-xs text-[var(--warning)]">
          <Hand size={12} className="shrink-0" aria-hidden />
          <span className="flex-1">You&apos;re driving — the agent is paused.</span>
          <button type="button" onClick={() => void takeover(false)} disabled={takeoverBusy} className="px-2 py-1 rounded-lg bg-[var(--bg-hover)] hover:bg-[var(--bg-hover-strong)] transition">
            Release
          </button>
        </div>
      )}

      {actionError && (
        <div className="shrink-0 px-3 py-2 text-ui-xs text-[var(--danger)] border-b border-[var(--border-subtle)]">
          {actionError}
        </div>
      )}

      <div className="flex-1 min-h-0 bg-black">
        {computer.active && computer.viewUrl ? (
          <iframe
            src={(computer.takeoverRequested && computer.interactiveUrl) || computer.viewUrl}
            title="Loop Bot computer"
            className="w-full h-full border-0"
            allow="clipboard-read; clipboard-write"
          />
        ) : (
          <div className="h-full flex flex-col items-center justify-center gap-2 text-[var(--ink-muted)] text-ui-xs px-6 text-center">
            <MonitorOff size={20} aria-hidden />
            {computer.active ? (
              <span>stream unavailable</span>
            ) : (
              <>
                <span>{computer.reason === 'not-running' ? 'This computer is not running.' : 'This run finished — its computer was shut down.'}</span>
                <span className="text-2xs opacity-70">Send the bot another task to boot a fresh computer.</span>
              </>
            )}
          </div>
        )}
      </div>

      {/* Takeover confirmation (product decision: always confirm) */}
      <ConfirmDialog
        open={confirmTakeover}
        title="Take the wheel?"
        body={`The agent pauses while you drive its computer. Release anytime — it auto-releases after ${timeoutMinutes} minutes.`}
        confirmLabel="Take over"
        busyLabel="Taking over…"
        busy={takeoverBusy}
        onConfirm={() => { void takeover(true) }}
        onCancel={() => setConfirmTakeover(false)}
      />
    </div>
  )
}
