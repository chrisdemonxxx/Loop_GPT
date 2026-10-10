'use client'

import { useState } from 'react'
import { Hand, Loader2 } from 'lucide-react'
import { setBotTakeover } from '../../lib/bot'
import type { BotComputer } from '../../lib/bot'
import { ConfirmDialog } from '@loop/ui'

/**
 * team-bot computer pane (sand's computer-screen-preview + takeover
 * handshake): sandbox metadata bar, takeover banner, the noVNC stream, and
 * the always-confirm takeover dialog.
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

  const takeover = async (seize: boolean) => {
    if (!runId) return
    setTakeoverBusy(true)
    try {
      const r = await setBotTakeover(runId, seize)
      setComputer((cur) => cur ? { ...cur, takeoverRequested: r.takeoverRequested, interactiveUrl: r.interactiveUrl } : cur)
      setConfirmTakeover(false)
    } finally {
      setTakeoverBusy(false)
    }
  }

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

      <div className="flex-1 min-h-0 bg-black">
        {computer.viewUrl ? (
          <iframe
            src={(computer.takeoverRequested && computer.interactiveUrl) || computer.viewUrl}
            title="Loop Bot computer"
            className="w-full h-full border-0"
            allow="clipboard-read; clipboard-write"
          />
        ) : (
          <div className="h-full flex items-center justify-center text-[var(--ink-muted)] text-ui-xs">stream unavailable</div>
        )}
      </div>

      {/* Takeover confirmation (product decision: always confirm) */}
      <ConfirmDialog
        open={confirmTakeover}
        title="Take the wheel?"
        body="The agent pauses while you drive its computer. Release anytime — it auto-releases after 10 minutes."
        confirmLabel="Take over"
        busyLabel="Taking over…"
        busy={takeoverBusy}
        onConfirm={() => { void takeover(true) }}
        onCancel={() => setConfirmTakeover(false)}
      />
    </div>
  )
}
