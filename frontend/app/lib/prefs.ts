'use client'

/**
 * Versioned client-preference store (S2 settings parity, contract
 * team/CONTRACT_S2_SETTINGS.md §3). Same pattern as lib/theme.ts: dark-first
 * defaults, localStorage persistence, one subscription fan-out.
 *
 * SERVER-BACKED STATE NEVER LIVES HERE — account, billing, memory, connectors
 * read their own APIs. This store is exactly the blueprint's client-side
 * preference surface: motion, chat font, notifications, voice, privacy toggles,
 * time-and-focus, and code-appearance prefs.
 *
 * Schema is versioned (`loop-prefs/v1`): unknown/missing keys fall back to
 * defaults, so adding a key later is a non-migration. Never rename a key —
 * add a new one and read the old only in an upgrade shim.
 */
import { useCallback, useEffect, useState } from 'react'

export const PREFS_STORAGE_KEY = 'loop-prefs/v1'

export type MotionChoice = 'system' | 'reduced'
export type ChatFontChoice = 'compact' | 'comfortable' | 'spacious'
export type CodeThemeChoice = 'dark' | 'light'
export type CodeFontChoice = 'mono' | 'serif-mono' | 'system-mono'

export interface QuietHours {
  enabled: boolean
  /** 0=Sun … 6=Sat */
  days: boolean[]
  /** minutes from midnight, 0–1439 */
  from: number
  to: number
}

export interface BreakReminders {
  enabled: boolean
  /** minutes of activity between breaks; 0 means "off" */
  everyMinutes: number
}

export interface UserPrefs {
  motion: MotionChoice
  chatFontSize: ChatFontChoice
  /** response-completion notifications */
  notifications: boolean
  voiceLanguage: string
  voiceSpeed: number
  helpImproveModels: boolean
  locationMetadata: boolean
  breakReminders: BreakReminders
  quietHours: QuietHours
  codeTheme: CodeThemeChoice
  codeFont: CodeFontChoice
}

export const DEFAULT_PREFS: UserPrefs = {
  motion: 'system',
  chatFontSize: 'comfortable',
  notifications: true,
  voiceLanguage: 'en-US',
  voiceSpeed: 1,
  helpImproveModels: false,
  locationMetadata: false,
  breakReminders: { enabled: false, everyMinutes: 0 },
  quietHours: { enabled: false, days: [false, false, false, false, false, false, false], from: 1320, to: 480 },
  codeTheme: 'dark',
  codeFont: 'mono',
}

/** Deep-enough validation: unknown shapes fall back to defaults per key. */
function readStored(): UserPrefs {
  const out: UserPrefs = { ...DEFAULT_PREFS }
  try {
    const raw = window.localStorage.getItem(PREFS_STORAGE_KEY)
    if (!raw) return out
    const parsed = JSON.parse(raw) as Partial<UserPrefs>
    if (parsed.motion === 'system' || parsed.motion === 'reduced') out.motion = parsed.motion
    if (parsed.chatFontSize === 'compact' || parsed.chatFontSize === 'comfortable' || parsed.chatFontSize === 'spacious') {
      out.chatFontSize = parsed.chatFontSize
    }
    if (typeof parsed.notifications === 'boolean') out.notifications = parsed.notifications
    if (typeof parsed.voiceLanguage === 'string' && parsed.voiceLanguage) out.voiceLanguage = parsed.voiceLanguage.slice(0, 12)
    if (typeof parsed.voiceSpeed === 'number' && parsed.voiceSpeed >= 0.5 && parsed.voiceSpeed <= 2) out.voiceSpeed = parsed.voiceSpeed
    if (typeof parsed.helpImproveModels === 'boolean') out.helpImproveModels = parsed.helpImproveModels
    if (typeof parsed.locationMetadata === 'boolean') out.locationMetadata = parsed.locationMetadata
    if (parsed.breakReminders && typeof parsed.breakReminders === 'object') {
      const br = parsed.breakReminders
      out.breakReminders = {
        enabled: !!br.enabled,
        everyMinutes: Math.max(0, Math.min(240, Math.floor(Number(br.everyMinutes) || 0))),
      }
    }
    if (parsed.quietHours && typeof parsed.quietHours === 'object') {
      const qh = parsed.quietHours
      const days = Array.isArray(qh.days) && qh.days.length === 7
        ? qh.days.map((d) => !!d)
        : DEFAULT_PREFS.quietHours.days
      out.quietHours = {
        enabled: !!qh.enabled,
        days,
        from: clampMinutes(qh.from, DEFAULT_PREFS.quietHours.from),
        to: clampMinutes(qh.to, DEFAULT_PREFS.quietHours.to),
      }
    }
    if (parsed.codeTheme === 'dark' || parsed.codeTheme === 'light') out.codeTheme = parsed.codeTheme
    if (parsed.codeFont === 'mono' || parsed.codeFont === 'serif-mono' || parsed.codeFont === 'system-mono') {
      out.codeFont = parsed.codeFont
    }
  } catch { /* private mode / corrupt JSON → defaults */ }
  return out
}

function clampMinutes(raw: unknown, fallback: number): number {
  const n = Math.floor(Number(raw))
  if (!Number.isFinite(n) || n < 0 || n > 1439) return fallback
  return n
}

// ── tiny store: write-through localStorage + listener fan-out ───────────────
type Listener = (prefs: UserPrefs) => void
const listeners = new Set<Listener>()
let cached: UserPrefs | null = null

function current(): UserPrefs {
  if (!cached) cached = typeof window === 'undefined' ? { ...DEFAULT_PREFS } : readStored()
  return cached
}

function commit(next: UserPrefs) {
  cached = next
  try { window.localStorage.setItem(PREFS_STORAGE_KEY, JSON.stringify(next)) } catch { /* private mode */ }
  for (const l of listeners) l(next)
}

export function getPrefs(): UserPrefs {
  return current()
}

/** Re-read localStorage and fan the result out (tests + cross-tab adoption). */
export function reloadPrefs(): UserPrefs {
  cached = readStored()
  commit(cached)
  return cached
}

export function setPrefs(patch: Partial<UserPrefs>): UserPrefs {
  const next = { ...current(), ...patch }
  commit(next)
  return next
}

export function subscribePrefs(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** React binding — re-renders on every prefs change. */
export function usePrefs(): { prefs: UserPrefs; update: (patch: Partial<UserPrefs>) => void } {
  const [prefs, setLocal] = useState<UserPrefs>(current)
  useEffect(() => {
    const unsub = subscribePrefs(setLocal)
    // Adopt changes made by another tab (storage event is same-key).
    const onStorage = (e: StorageEvent) => { if (e.key === PREFS_STORAGE_KEY) setLocal(readStored()) }
    window.addEventListener('storage', onStorage)
    return () => { unsub(); window.removeEventListener('storage', onStorage) }
  }, [])
  const update = useCallback((patch: Partial<UserPrefs>) => { setPrefs(patch) }, [])
  return { prefs, update }
}

/** Apply the side-effects the prefs own (chat font scale, motion, code theme).
 *  Called once from the provider in layout — not per component. */
export function applyPrefsSideEffects(prefs: UserPrefs) {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  root.dataset.chatFont = prefs.chatFontSize
  root.dataset.motion = prefs.motion
  root.dataset.codeTheme = prefs.codeTheme
  root.dataset.codeFont = prefs.codeFont
}