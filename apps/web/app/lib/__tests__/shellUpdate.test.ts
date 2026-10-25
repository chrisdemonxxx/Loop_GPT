import { describe, expect, it, vi } from 'vitest'
import { watchShellUpdate } from '../shellUpdate'

describe('app shell updates', () => {
  it('reloads an open tab once when the new shell takes control', () => {
    const listeners: Array<() => void> = []
    const reload = vi.fn()
    watchShellUpdate({
      controller: {} as ServiceWorker,
      addEventListener: (_type, listener) => listeners.push(listener),
    }, reload)
    listeners.forEach((listener) => listener())
    listeners.forEach((listener) => listener())
    expect(reload).toHaveBeenCalledOnce()
  })

  it('does not reload a first visit that has no controlling worker', () => {
    const reload = vi.fn()
    watchShellUpdate({ controller: null, addEventListener: () => {} }, reload)
    expect(reload).not.toHaveBeenCalled()
  })
})
