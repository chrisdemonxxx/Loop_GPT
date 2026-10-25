import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { usePanels } from '../hooks'

function stubWidth(px: number) {
  vi.stubGlobal('matchMedia', vi.fn((query: string) => {
    const min = Number(/min-width:\s*(\d+)px/.exec(query)?.[1] || 0)
    return { matches: px >= min, addEventListener: () => {}, removeEventListener: () => {} }
  }))
}

afterEach(() => vi.unstubAllGlobals())

const escape = () => act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })) })

describe('usePanels Escape', () => {
  it('closes the mobile drawer', () => {
    stubWidth(390)
    const { result } = renderHook(() => usePanels())
    act(() => result.current.setSidebarOpen(true))
    escape()
    expect(result.current.sidebarOpen).toBe(false)
  })

  it('leaves the docked tablet sidebar open', () => {
    stubWidth(1024)
    const { result } = renderHook(() => usePanels())
    expect(result.current.sidebarOpen).toBe(true)
    escape()
    expect(result.current.sidebarOpen).toBe(true)
  })

  it('ignores an Escape a dialog already claimed', () => {
    stubWidth(390)
    const { result } = renderHook(() => usePanels())
    act(() => result.current.setSidebarOpen(true))
    act(() => {
      const e = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })
      e.preventDefault()
      window.dispatchEvent(e)
    })
    expect(result.current.sidebarOpen).toBe(true)
  })
})
