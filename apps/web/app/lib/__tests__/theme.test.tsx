import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, renderHook } from '@testing-library/react'
import { ThemeProvider, resolveTheme, useTheme, THEME_STORAGE_KEY } from '../theme'

/** Theme switcher (audit §8-35): choice → data-theme attribute, persistence,
 *  and live system resolution. Dark stays the default (no attribute). */

// jsdom has no matchMedia by default.
function stubMatchMedia(light: boolean) {
  const listeners = new Set<(e: { matches: boolean }) => void>()
  const mq = {
    matches: light,
    addEventListener: (_: string, cb: any) => listeners.add(cb),
    removeEventListener: (_: string, cb: any) => listeners.delete(cb),
  }
  vi.stubGlobal('matchMedia', vi.fn(() => mq))
  return {
    flip(next: boolean) {
      mq.matches = next
      for (const cb of listeners) cb({ matches: next })
    },
  }
}

beforeEach(() => {
  window.localStorage.clear()
  delete document.documentElement.dataset.theme
})
afterEach(() => {
  vi.unstubAllGlobals()
  delete document.documentElement.dataset.theme
})

describe('resolveTheme', () => {
  it('passes explicit choices through', () => {
    expect(resolveTheme('dark')).toBe('dark')
    expect(resolveTheme('light')).toBe('light')
  })
  it('resolves system via the OS preference', () => {
    stubMatchMedia(true)
    expect(resolveTheme('system')).toBe('light')
    stubMatchMedia(false)
    expect(resolveTheme('system')).toBe('dark')
  })
  it('defaults to dark when matchMedia is unavailable', () => {
    vi.stubGlobal('matchMedia', undefined)
    expect(resolveTheme('system')).toBe('dark')
  })
})

describe('ThemeProvider', () => {
  it('applies light to the document element and persists the choice', () => {
    const { result } = renderHook(() => useTheme(), { wrapper: ThemeProvider })
    expect(result.current.resolved).toBe('dark')
    expect(document.documentElement.dataset.theme).toBeUndefined()
    act(() => result.current.setChoice('light'))
    expect(document.documentElement.dataset.theme).toBe('light')
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('light')
  })

  it('removes the attribute when switching back to dark', () => {
    const { result } = renderHook(() => useTheme(), { wrapper: ThemeProvider })
    act(() => result.current.setChoice('light'))
    act(() => result.current.setChoice('dark'))
    expect(document.documentElement.dataset.theme).toBeUndefined()
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark')
  })

  it('adopts the stored choice on mount', () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'light')
    const { result } = renderHook(() => useTheme(), { wrapper: ThemeProvider })
    // The adoption effect runs on mount.
    expect(result.current.choice).toBe('light')
    expect(document.documentElement.dataset.theme).toBe('light')
  })

  it('follows OS changes live while on system', () => {
    const media = stubMatchMedia(false)
    const { result } = renderHook(() => useTheme(), { wrapper: ThemeProvider })
    act(() => result.current.setChoice('system'))
    expect(document.documentElement.dataset.theme).toBeUndefined() // OS = dark
    act(() => media.flip(true))
    expect(document.documentElement.dataset.theme).toBe('light') // OS flipped
    act(() => media.flip(false))
    expect(document.documentElement.dataset.theme).toBeUndefined()
  })

  it('provides a safe default context outside the provider', () => {
    const { result } = renderHook(() => useTheme())
    expect(result.current.choice).toBe('dark')
    expect(() => result.current.setChoice('light')).not.toThrow()
  })

  it('renders children', () => {
    const { getByText } = render(<ThemeProvider><span>content</span></ThemeProvider>)
    expect(getByText('content')).toBeInTheDocument()
  })
})
