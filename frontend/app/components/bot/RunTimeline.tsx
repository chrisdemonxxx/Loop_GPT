'use client'

/** The run feed as an iconified timeline with a live "current thought" line.
 *  Thinking/delta events collapse into the latest one so a reasoning-heavy
 *  run never looks like an empty feed. */
import type { BotFeedEvent } from '../../lib/botSse'

export function RunTimeline({ events, status, compact }: { events: BotFeedEvent[]; status?: string; compact?: boolean }) {
  const visible = events.filter((e) => e.type !== 'thinking' && e.type !== 'delta')
  const lastThought = [...events].reverse().find((e) => (e.type === 'thinking' || e.type === 'delta') && String((e as any).text || (e as any).content || '').trim())
  const lines = visible.slice(-150).map((e, i) => {
    if (e.type === 'status') return <div key={i} className="text-sky-400/80">◦ {e.message}</div>
    if (e.type === 'tool_call') return <div key={i} className="text-violet-300">→ {e.name}</div>
    if (e.type === 'tool_result') return <div key={i} className="text-slate-500 truncate">✓ {String(e.content || '').slice(0, 140)}</div>
    if (e.type === 'tool_output') return <div key={i} className="text-slate-600 truncate">{String((e as any).chunk || '').slice(0, 140)}</div>
    if (e.type === 'artifact') return <div key={i} className="text-amber-300/80 truncate">📎 {String((e as any).artifact?.name || 'artifact')}</div>
    if (e.type === 'final') return <div key={i} className="text-emerald-300">■ {String(e.content || '').slice(0, 200)}</div>
    if (e.type === 'error') return <div key={i} className="text-rose-400">✕ {e.message}</div>
    return null
  })
  if (status === 'running' && lastThought) {
    const text = String((lastThought as any).text || (lastThought as any).content || '').replace(/\s+/g, ' ').trim().slice(0, 300)
    lines.push(<div key="thought" className="text-slate-400/70 italic truncate">💭 {text}…</div>)
  }
  return (
    <div className={`${compact ? 'h-44' : 'h-56'} space-y-1 overflow-y-auto rounded-lg bg-slate-950/60 p-2 font-mono text-[11px]`}>
      {lines.length ? lines : <div className="text-slate-600">No events yet.</div>}
    </div>
  )
}