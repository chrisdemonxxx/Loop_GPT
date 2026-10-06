'use client'

/**
 * Theme switcher (audit §8-35): light / dark / system. The app's CSS is
 * dark-first — the light palette is an override layer in globals.css keyed
 * on `<html data-theme="light">`, so this provider only owns the choice,
 * persistence, system resolution, and keeping the attribute in sync.
 *
 * Dark stays the default (no `data-theme` attribute = dark): existing
 * users see zero change until they opt in.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'

export type ThemeChoice = 'light' | 'dark' | 'system'
export const THEME_STORAGE_KEY = 'loop-theme'

export function resolveTheme(choice: ThemeChoice): 'light' | 'dark' {
  if (choice !== 'system') return choice
  if (typeof window === 'undefined' || !window.matchMedia) return 'dark'
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}

/** Apply a resolved theme to the document: the data-theme attribute drives
 *  the CSS override layer, and the PWA chrome (theme-color meta) follows. */
function applyTheme(resolved: 'light' | 'dark') {
  const root = document.documentElement
  if (resolved === 'light') root.dataset.theme = 'light'
  else delete root.dataset.theme
  // Keep the installed-app chrome in sync with the active surface.
  let meta = document.querySelector('meta[name="theme-color"]')
  if (!meta) {
    meta = document.createElement('meta')
    meta.setAttribute('name', 'theme-color')
    document.head.appendChild(meta)
  }
  meta.setAttribute('content', resolved === 'light' ? '#fafafa' : '#0b0b12')
}

interface ThemeContextValue {
  choice: ThemeChoice
  resolved: 'light' | 'dark'
  setChoice: (choice: ThemeChoice) => void
}

const ThemeContext = createContext<ThemeContextValue>({
  choice: 'dark',
  resolved: 'dark',
  setChoice: () => {},
})

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [choice, setChoiceState] = useState<ThemeChoice>('dark')

  // Adopt whatever the no-flash head script already applied (localStorage).
  useEffect(() => {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY)
    if (stored === 'light' || stored === 'dark' || stored === 'system') setChoiceState(stored)
  }, [])

  // Keep the document attribute in sync with the choice.
  useEffect(() => {
    applyTheme(resolveTheme(choice))
  }, [choice])

  // System choice: follow OS changes live.
  useEffect(() => {
    if (choice !== 'system' || !window.matchMedia) return
    const mq = window.matchMedia('(prefers-color-scheme: light)')
    const onChange = () => applyTheme(resolveTheme('system'))
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [choice])

  const setChoice = useCallback((next: ThemeChoice) => {
    setChoiceState(next)
    try { window.localStorage.setItem(THEME_STORAGE_KEY, next) } catch { /* private mode */ }
  }, [])

  const value = useMemo<ThemeContextValue>(() => ({
    choice,
    resolved: resolveTheme(choice),
    setChoice,
  }), [choice, setChoice])

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme() {
  return useContext(ThemeContext)
}

/**
 * Inline head script (layout.tsx): applies the stored choice BEFORE first
 * paint so a light-theme user never sees a dark flash on load. Mirrors
 * resolveTheme()'s logic — keep them in sync.
 */
export const THEME_BOOT_SCRIPT = `(function(){try{var c=localStorage.getItem('${THEME_STORAGE_KEY}');var r=c;if(r==='system'){r=window.matchMedia&&window.matchMedia('(prefers-color-scheme: light)').matches?'light':'dark'}if(r==='light'){document.documentElement.dataset.theme='light'}}catch(e){}})()`
