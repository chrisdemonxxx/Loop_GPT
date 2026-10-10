'use client'

/** Enqueue form: goal, schedule, steps, dedicated computer + TTL. Shared by the
 *  admin console and the user page; the user page passes plan-gated flags. */
import { useState } from 'react'
import { Bot, Loader2, MonitorPlay, Play } from 'lucide-react'

export function EnqueueForm({
  onEnqueue, busy, computerAllowed, computerHint,
}: {
  onEnqueue: (input: { goal: string; kind: 'ops' | 'scheduled' | 'teach'; schedule?: string; maxSteps: number; computer?: { enabled: boolean; ttlMinutes: number } }) => Promise<void>
  busy: boolean
  computerAllowed: boolean
  computerHint?: string
}) {
  const [mode, setMode] = useState<'task' | 'teach'>('task')
  const [goal, setGoal] = useState('')
  const [schedule, setSchedule] = useState('')
  const [maxSteps, setMaxSteps] = useState(16)
  const [computer, setComputer] = useState(false)
  const [ttl, setTtl] = useState(30)

  const teach = mode === 'teach'
  const effectiveComputer = teach || (computer && computerAllowed)

  const submit = async () => {
    if (!goal.trim() || busy) return
    await onEnqueue({
      goal: goal.trim(),
      kind: teach ? 'teach' : schedule ? 'scheduled' : 'ops',
      ...(schedule && !teach ? { schedule } : {}),
      maxSteps,
      ...(effectiveComputer ? { computer: { enabled: true, ttlMinutes: ttl } } : {}),
    })
    setGoal('')
  }

  return (
    <div className="glass rounded-2xl p-4 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm font-medium text-[var(--ink-primary)]"><Bot size={15} className="text-[var(--accent-text)]" /> {teach ? 'Teach the bot a task' : 'New task'}</div>
        <div className="flex rounded-lg bg-[var(--bg-tint)] p-0.5 ring-1 ring-[var(--border-subtle)]">
          <button onClick={() => setMode('task')} className={`rounded-md px-2.5 py-1 text-2xs font-medium transition ${!teach ? 'bg-[var(--accent-fill)] text-white' : 'text-[var(--ink-secondary)] hover:text-[var(--ink-primary)]'}`}>Task</button>
          <button onClick={() => setMode('teach')} className={`rounded-md px-2.5 py-1 text-2xs font-medium transition ${teach ? 'bg-[var(--accent-fill)] text-white' : 'text-[var(--ink-secondary)] hover:text-[var(--ink-primary)]'}`}>🎓 Teach</button>
        </div>
      </div>
      <textarea
        value={goal} onChange={(e) => setGoal(e.target.value)} rows={2}
        placeholder={teach
          ? 'Describe the task you are about to demonstrate on the computer…'
          : 'Goal for the autonomous agent… (e.g. research, browse, build, teach)'}
        className="w-full rounded-lg bg-[var(--bg-tint)] px-3 py-2 text-sm outline-none ring-1 ring-[var(--border-subtle)] focus:ring-[var(--accent)]"
      />
      {teach && (
        <div className="rounded-lg bg-[var(--accent-soft)] px-3 py-1.5 text-2xs text-[var(--accent-text)]">
          The bot opens the live computer and waits. Take over, demonstrate the task, press Release — the bot watches the
          recording and writes it into a reusable Skill you can queue with one click.
        </div>
      )}
      {!teach && (
        <div className="flex flex-wrap items-center gap-3 text-xs text-[var(--ink-secondary)]">
          <label className="flex items-center gap-1.5">Every
            <select value={schedule} onChange={(e) => setSchedule(e.target.value)} className="rounded bg-[var(--bg-tint)] px-2 py-1 ring-1 ring-[var(--border-subtle)]">
              <option value="">once</option><option value="30m">30m</option><option value="1h">1h</option>
              <option value="6h">6h</option><option value="1d">1d</option>
            </select>
          </label>
          <label className="flex items-center gap-1.5">Steps
            <input type="number" min={1} max={64} value={maxSteps} onChange={(e) => setMaxSteps(Number(e.target.value))} className="w-14 rounded bg-[var(--bg-tint)] px-2 py-1 ring-1 ring-[var(--border-subtle)]" />
          </label>
          <label className={`flex items-center gap-1.5 ${computerAllowed ? '' : 'opacity-40'}`}>
            <input type="checkbox" checked={computer && computerAllowed} disabled={!computerAllowed} onChange={(e) => setComputer(e.target.checked)} />
            <MonitorPlay size={13} /> Dedicated computer
          </label>
          {computer && computerAllowed && (
            <label className="flex items-center gap-1.5">TTL min
              <input type="number" min={5} max={240} value={ttl} onChange={(e) => setTtl(Number(e.target.value))} className="w-16 rounded bg-[var(--bg-tint)] px-2 py-1 ring-1 ring-[var(--border-subtle)]" />
            </label>
          )}
          {computerHint && <span className="text-2xs text-[var(--ink-muted)]">{computerHint}</span>}
        </div>
      )}
      <button onClick={submit} disabled={busy || !goal.trim()} className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-gradient-to-r from-[var(--accent-fill)] to-sky-600 px-4 py-2 text-xs font-semibold text-white hover:from-[var(--accent-fill-hover)] hover:to-sky-500 disabled:opacity-40">
        {busy ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />} {teach ? 'Start teach session' : 'Queue'}
      </button>
    </div>
  )
}