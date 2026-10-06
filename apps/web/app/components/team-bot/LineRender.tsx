'use client'

import { useEffect, useRef } from 'react'
import { CheckCircle2, Loader2 } from 'lucide-react'
import type { BotEvent } from '../../lib/bot'

/**
 * team-bot line-render: the run trace, one colored line per event kind
 * (sand's team-bot-line-render module). Auto-sticks to the bottom while
 * events stream in.
 */
export function LineRender({ events, attaching }: { events: BotEvent[]; attaching: boolean }) {
  const endRef = useRef<HTMLDivElement>(null)
  const lines = events.filter((e) => e.type !== 'done')

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'instant' as ScrollBehavior, block: 'end' })
  }, [events])

  return (
    <div className="flex-1 overflow-y-auto min-h-0 px-3 py-2 font-mono text-[11.5px] leading-relaxed">
      {lines.length === 0 && attaching && (
        <div className="flex items-center gap-2 text-slate-500 px-1 py-2"><Loader2 size={12} className="animate-spin" /> attaching…</div>
      )}
      {lines.map((e, i) => <TraceLine key={i} event={e} />)}
      <div ref={endRef} />
    </div>
  )
}

/** One trace line, colored by event kind. */
export function TraceLine({ event }: { event: BotEvent }) {
  switch (event.type) {
    case 'status':
    case 'warming':
      return <div className="text-slate-500 py-0.5">· {event.message}</div>
    case 'tool_call':
      return <div className="text-sky-300/90 py-0.5">▸ {event.name}{event.args ? <span className="text-slate-600"> {truncate(JSON.stringify(event.args), 90)}</span> : null}</div>
    case 'tool_output':
      return <div className="text-slate-600 py-0.5 truncate">│ {truncate(event.chunk || '', 120)}</div>
    case 'tool_result':
      return <div className={`py-0.5 ${event.isError ? 'text-rose-300' : 'text-slate-400'}`}>└ {event.isError ? 'failed' : 'done'}{event.content ? <span className="text-slate-600"> — {truncate(event.content, 110)}</span> : null}</div>
    case 'artifact':
      return <div className="text-emerald-300/90 py-0.5">✦ created {event.artifact?.name}</div>
    case 'final':
      return <div className="text-emerald-300 py-0.5 flex items-center gap-1"><CheckCircle2 size={11} /> {truncate(event.content || 'done', 160)}</div>
    case 'error':
      return <div className="text-rose-300 py-0.5">⚠ {event.message}</div>
    default:
      return null
  }
}

function truncate(s: string, n: number) { return s.length > n ? s.slice(0, n - 1) + '…' : s }