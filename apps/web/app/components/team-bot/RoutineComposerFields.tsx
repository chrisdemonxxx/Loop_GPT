'use client'

import { useState } from 'react'

const ZONES = ['UTC', 'America/New_York', 'America/Los_Angeles', 'Europe/London', 'Asia/Tokyo']

function initialPreset(value: string): string {
  if (value.startsWith('hourly')) return 'hourly'
  if (value.startsWith('daily@')) return 'daily'
  if (value.startsWith('weekdays@')) return 'weekdays'
  if (value.startsWith('weekly:')) return 'weekly'
  return 'custom'
}

function scheduleString(preset: string, time: string, weekday: string, timeZone: string, away: boolean): string {
  const clock = time || '09:00'
  let expr = '1d'
  if (preset === 'hourly') expr = 'hourly'
  else if (preset === 'daily') expr = `daily@${clock}`
  else if (preset === 'weekdays') expr = `weekdays@${clock}`
  else if (preset === 'weekly') expr = `weekly:${weekday}@${clock}`
  return `${expr}|${timeZone}${away ? '|away' : ''}`
}

function nextRunLabel(preset: string, time: string, timeZone: string): string {
  if (preset === 'hourly') return `Next run in about an hour (${timeZone})`
  const [hour, minute] = (time || '09:00').split(':')
  const h = Number(hour)
  const shown = `${h % 12 || 12}:${minute}`
  return `Next run ${shown} (${timeZone})`
}

export function RoutineComposerFields({
  value,
  timeZone = 'UTC',
  onChange,
}: {
  value: string
  timeZone?: string
  onChange: (next: { schedule: string; timeZone: string }) => void
  now?: Date
}) {
  const [preset, setPreset] = useState(initialPreset(value))
  const [time, setTime] = useState('09:30')
  const [zone, setZone] = useState(timeZone)
  const [weekday, setWeekday] = useState('mon')
  const [away, setAway] = useState(true)
  const emit = (next: { preset?: string; time?: string; zone?: string; weekday?: string; away?: boolean }) => {
    const schedule = scheduleString(next.preset ?? preset, next.time ?? time, next.weekday ?? weekday, next.zone ?? zone, next.away ?? away)
    onChange({ schedule, timeZone: next.zone ?? zone })
  }
  return (
    <div className="space-y-2">
      <label className="block text-2xs text-[var(--ink-muted)]">
        Schedule
        <select
          aria-label="Schedule"
          value={preset}
          onChange={(e) => { setPreset(e.target.value); emit({ preset: e.target.value }) }}
          className="mt-1 w-full rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-base)] px-2 py-1 text-ui-xs"
        >
          <option value="hourly">Every hour</option>
          <option value="daily">Every day</option>
          <option value="weekdays">Weekdays</option>
          <option value="weekly">Weekly</option>
          <option value="custom">Custom interval</option>
        </select>
      </label>
      {preset !== 'hourly' && preset !== 'custom' && (
        <label className="block text-2xs text-[var(--ink-muted)]">
          Time
          <input aria-label="Time" type="time" value={time} onChange={(e) => { setTime(e.target.value); emit({ time: e.target.value }) }} className="mt-1 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-base)] px-2 py-1 text-ui-xs" />
        </label>
      )}
      {preset === 'weekly' && (
        <label className="block text-2xs text-[var(--ink-muted)]">
          Day
          <select aria-label="Weekday" value={weekday} onChange={(e) => { setWeekday(e.target.value); emit({ weekday: e.target.value }) }} className="mt-1 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-base)] px-2 py-1 text-ui-xs">
            {['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((day) => <option key={day} value={day}>{day}</option>)}
          </select>
        </label>
      )}
      <label className="block text-2xs text-[var(--ink-muted)]">
        Timezone
        <select
          aria-label="Timezone"
          value={zone}
          onChange={(e) => { setZone(e.target.value); emit({ zone: e.target.value }) }}
          className="mt-1 w-full rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-base)] px-2 py-1 text-ui-xs"
        >
          {ZONES.map((entry) => <option key={entry} value={entry}>{entry}</option>)}
        </select>
      </label>
      <label className="flex items-center gap-1.5 text-2xs text-[var(--ink-secondary)]">
        <input type="checkbox" aria-label="Pause while away" checked={away} onChange={(e) => { setAway(e.target.checked); emit({ away: e.target.checked }) }} />
        Pause after 7 days away
      </label>
      <p className="text-2xs text-[var(--ink-muted)]">{nextRunLabel(preset, time, zone)}</p>
    </div>
  )
}
