import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_PREFS, PREFS_STORAGE_KEY, getPrefs, setPrefs, subscribePrefs, usePrefs, reloadPrefs,
} from '../prefs'
import { renderHook, act } from '@testing-library/react'

const store = () => window.localStorage.getItem(PREFS_STORAGE_KEY)

describe('prefs store (loop-prefs/v1)', () => {
  beforeEach(() => { window.localStorage.clear() })
  afterEach(() => { vi.restoreAllMocks() })

  it('serves defaults for a fresh browser', () => {
    expect(getPrefs()).toEqual(DEFAULT_PREFS)
    expect(store()).toBeNull()
  })

  it('persists patches and fans out to subscribers', () => {
    const seen: unknown[] = []
    const unsub = subscribePrefs((p) => seen.push(p))
    setPrefs({ helpImproveModels: true, voiceSpeed: 1.5 })
    expect(getPrefs().helpImproveModels).toBe(true)
    expect(getPrefs().voiceSpeed).toBe(1.5)
    const raw = JSON.parse(store()!) as Record<string, unknown>
    expect(raw.helpImproveModels).toBe(true)
    unsub()
    setPrefs({ helpImproveModels: false })
    expect(seen).toHaveLength(1) // unsubscribed before the second write
  })

  it('falls back per-key on corrupt or out-of-range values', () => {
    window.localStorage.setItem(PREFS_STORAGE_KEY, JSON.stringify({
      motion: 'spinny', chatFontSize: 'huge', voiceSpeed: 99,
      quietHours: { enabled: true, days: [true], from: -40, to: 99999 },
      breakReminders: { enabled: true, everyMinutes: 5000 },
    }))
    const p = reloadPrefs()
    expect(p.motion).toBe('system')
    expect(p.chatFontSize).toBe('comfortable')
    expect(p.voiceSpeed).toBe(1)
    expect(p.quietHours).toEqual({ enabled: true, days: DEFAULT_PREFS.quietHours.days, from: DEFAULT_PREFS.quietHours.from, to: DEFAULT_PREFS.quietHours.to })
    expect(p.breakReminders).toEqual({ enabled: true, everyMinutes: 240 })
  })

  it('survives corrupt JSON without throwing', () => {
    window.localStorage.setItem(PREFS_STORAGE_KEY, '{not json')
    expect(reloadPrefs()).toEqual(DEFAULT_PREFS)
  })

  it('usePrefs re-renders on update', () => {
    const { result } = renderHook(() => usePrefs())
    expect(result.current.prefs.notifications).toBe(true)
    act(() => { result.current.update({ notifications: false }) })
    expect(result.current.prefs.notifications).toBe(false)
    expect(JSON.parse(store()!).notifications).toBe(false)
  })
})