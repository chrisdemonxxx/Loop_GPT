'use client'

/** The hero: live noVNC view of the dedicated VM with a session HUD
 *  (LIVE pulse, sandbox, minutes, takeover countdown) and drive controls. */
import { MonitorPlay, MonitorOff, HandMetal, Loader2, Maximize2 } from 'lucide-react'

interface ComputerInfo {
  active: boolean
  sandboxId: string
  viewUrl: string | null
  interactiveUrl: string | null
  takeoverRequested: boolean
  minutes: number | null
  startedAt: string | null
  endedAt: string | null
}

export function LiveComputerCard({
  info, takeover, takeoverBusy,
}: {
  info: ComputerInfo
  takeover: (on: boolean) => void
  takeoverBusy: boolean
}) {
  return (
    <div className="glass relative overflow-hidden rounded-2xl">
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-br from-violet-500/10 via-transparent to-sky-500/10" />
      <div className="relative p-4 space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-sm font-medium text-slate-200">
            <MonitorPlay size={15} className="text-violet-400" /> Live computer
            <span className="rounded-md bg-slate-900/80 px-1.5 py-0.5 font-mono text-[10px] text-slate-400 ring-1 ring-slate-700/70">{info.sandboxId}</span>
            {info.active && (
              <span className="relative flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-emerald-400">
                <span className="relative flex h-1.5 w-1.5"><span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75"></span><span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500"></span></span>
                live
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {info.viewUrl && (
              <a href={(info.takeoverRequested && info.interactiveUrl) || info.viewUrl} target="_blank" rel="noreferrer"
                className="flex items-center gap-1 rounded-lg border border-white/10 px-2 py-1 text-[11px] text-slate-400 hover:text-slate-200" title="Open fullscreen (noVNC toolbar)">
                <Maximize2 size={11} /> Fullscreen
              </a>
            )}
            {info.takeoverRequested ? (
              <button onClick={() => takeover(false)} disabled={takeoverBusy}
                className="flex items-center gap-1.5 rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-500 disabled:opacity-40">
                {takeoverBusy ? <Loader2 size={13} className="animate-spin" /> : <MonitorOff size={13} />} Release control
              </button>
            ) : (
              <button onClick={() => takeover(true)} disabled={takeoverBusy || !info.active}
                className="flex items-center gap-1.5 rounded-lg bg-sky-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-sky-500 disabled:opacity-40">
                {takeoverBusy ? <Loader2 size={13} className="animate-spin" /> : <HandMetal size={13} />} Take over
              </button>
            )}
          </div>
        </div>
        {info.takeoverRequested && (
          <div className="rounded-lg bg-amber-500/10 px-3 py-1.5 text-[11px] text-amber-300">
            You are driving. The bot is paused and will resume from a fresh screenshot when you release.
          </div>
        )}
        <div className="relative w-full overflow-hidden rounded-xl ring-1 ring-slate-700/60" style={{ aspectRatio: '16 / 10' }}>
          <iframe
            src={(info.takeoverRequested && info.interactiveUrl) || info.viewUrl || ''}
            className="absolute inset-0 h-full w-full bg-black"
            referrerPolicy="no-referrer"
            title="Bot computer live view"
          />
        </div>
        <div className="flex flex-wrap items-center gap-3 text-[11px] text-slate-500">
          <span>A black desktop = nothing opened yet — check the agent frames for what it sees.</span>
          {info.minutes != null && <span className="ml-auto rounded-md bg-slate-900/80 px-1.5 py-0.5 ring-1 ring-slate-700/70">⚡ {info.minutes} VM-minute(s) metered</span>}
        </div>
      </div>
    </div>
  )
}