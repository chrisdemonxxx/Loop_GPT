'use client'

import { Clock, MoonStar } from 'lucide-react'
import { usePrefs } from '../../lib/prefs'
import { SectionHeader, Toggle } from '../ui/primitives'

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** minutes-from-midnight → 24h "HH:MM" for a number input. */
function toHHMM(n: number): string {
  const h = Math.floor(n / 60), m = n % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}
function fromHHMM(s: string, fallback: number): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim())
  if (!m) return fallback
  const total = Number(m[1]) * 60 + Number(m[2])
  return total >= 0 && total <= 1439 ? total : fallback
}

/**
 * Time and focus (blueprint §8): break reminders + quiet hours — REAL
 * enforcement (redesign decision): the break timer fires quiet-hours-gated
 * notifications (toast fallback when the browser denies them), and quiet
 * hours mute every app notification via lib/reminders.notify.
 */
export default function TimeFocusTab() {
  const { prefs, update } = usePrefs()
  const { breakReminders, quietHours } = prefs

  return (
    <div className="space-y-5">
      <SectionHeader title="Break reminders" />
      <div className="rounded-xl border border-white/[0.06] p-3.5">
        <div className="flex items-center justify-between gap-3">
          <span className="flex min-w-0 items-start gap-2.5 text-[13px]">
            <Clock size={14} className="mt-0.5 shrink-0 text-slate-500" />
            <span>
              <span className="block text-slate-300">Remind me to take breaks</span>
              <span className="block text-[11px] text-slate-500">
                {breakReminders.enabled
                  ? `On — you'll get a notification every ${breakReminders.everyMinutes || 50} minutes`
                  : 'A notification (or in-app note) when you\'ve been going a while'}
              </span>
            </span>
          </span>
          <Toggle
            on={breakReminders.enabled}
            onChange={(on) => update({ breakReminders: { ...breakReminders, enabled: on, everyMinutes: on && !breakReminders.everyMinutes ? 50 : breakReminders.everyMinutes } })}
            label="Remind me to take breaks"
          />
        </div>
        {breakReminders.enabled && (
          <label className="mt-3 flex items-center justify-between gap-3 text-[12px] text-slate-400">
            <span>Every</span>
            <span className="flex items-center gap-1.5">
              <input
                type="number" min={5} max={240} step={5}
                aria-label="Break interval minutes"
                value={breakReminders.everyMinutes || ''}
                placeholder="50"
                onChange={(e) => update({ breakReminders: { ...breakReminders, everyMinutes: Math.max(0, Math.min(240, Number(e.target.value) || 0)) } })}
                className="w-16 rounded-lg border border-white/10 bg-[#14141f] px-2 py-1 text-right text-slate-200 focus:border-[#c96442]/50 focus:outline-none"
              />
              <span>minutes</span>
            </span>
          </label>
        )}
      </div>

      <SectionHeader title="Quiet hours" />
      <div className="rounded-xl border border-white/[0.06] p-3.5">
        <div className="flex items-center justify-between gap-3">
          <span className="flex min-w-0 items-start gap-2.5 text-[13px]">
            <MoonStar size={14} className="mt-0.5 shrink-0 text-slate-500" />
            <span>
              <span className="block text-slate-300">Mute notifications at set hours</span>
              <span className="block text-[11px] text-slate-500">
                {quietHours.enabled
                  ? `Active ${toHHMM(quietHours.from)}–${toHHMM(quietHours.to)} — all app notifications pause`
                  : 'No app notifications inside the window you pick'}
              </span>
            </span>
          </span>
          <Toggle on={quietHours.enabled} onChange={(on) => update({ quietHours: { ...quietHours, enabled: on } })} label="Mute notifications at set hours" />
        </div>
        <div role="radiogroup" aria-label="Quiet hours days" className="mt-3 flex flex-wrap gap-1.5">
          {DAYS.map((d, i) => (
            <button
              key={d}
              type="button"
              role="radio"
              aria-checked={quietHours.days[i]}
              aria-label={d}
              disabled={!quietHours.enabled}
              onClick={() => {
                const days = [...quietHours.days]
                days[i] = !days[i]
                update({ quietHours: { ...quietHours, days } })
              }}
              className={`rounded-lg border px-2.5 py-1 text-[11px] transition ${
                quietHours.days[i]
                  ? 'border-[#c96442]/50 bg-[#c96442]/[0.08] text-[#e79d7f]'
                  : 'border-white/[0.08] text-slate-500 hover:text-slate-300'
              } ${!quietHours.enabled ? 'opacity-50' : ''}`}
            >
              {d}
            </button>
          ))}
        </div>
        {quietHours.enabled && (
          <div className="mt-3 flex items-center justify-between gap-3 text-[12px] text-slate-400">
            <span>Between</span>
            <span className="flex items-center gap-2">
              <input
                type="time" aria-label="Quiet hours start"
                value={toHHMM(quietHours.from)}
                onChange={(e) => update({ quietHours: { ...quietHours, from: fromHHMM(e.target.value, quietHours.from) } })}
                className="rounded-lg border border-white/10 bg-[#14141f] px-2 py-1 text-slate-200 focus:border-[#c96442]/50 focus:outline-none"
              />
              <span>and</span>
              <input
                type="time" aria-label="Quiet hours end"
                value={toHHMM(quietHours.to)}
                onChange={(e) => update({ quietHours: { ...quietHours, to: fromHHMM(e.target.value, quietHours.to) } })}
                className="rounded-lg border border-white/10 bg-[#14141f] px-2 py-1 text-slate-200 focus:border-[#c96442]/50 focus:outline-none"
              />
            </span>
          </div>
        )}
      </div>
    </div>
  )
}