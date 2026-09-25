import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import ArtifactsPanel from '../ArtifactsPanel'
import Composer from '../Composer'
import { useKeyboardSafeBottom } from '../../../chat/hooks'
import type { ArtifactRef } from '../../../lib/stream'

/** Responsive behaviors (audit P6): keyboard-safe composer offset, mobile
 * bottom-sheet panel, and 44px tap targets on the compact composer controls. */

function Harness() {
  useKeyboardSafeBottom()
  return null
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, text: async () => 'body', json: async () => ({}) })))
})
afterEach(() => vi.unstubAllGlobals())

describe('useKeyboardSafeBottom', () => {
  it('writes the keyboard intrusion distance to --kb-offset on viewport resize', () => {
    const listeners: Record<string, () => void> = {}
    const fakeViewport = {
      height: 400, offsetTop: 0,
      addEventListener: (_: string, fn: () => void) => { listeners[_] = fn },
      removeEventListener: (_: string) => { delete listeners[_] },
    }
    vi.stubGlobal('innerHeight', 800)
    vi.stubGlobal('visualViewport', fakeViewport)
    render(<Harness />)
    // 800 - 400 - 0 = 400px of keyboard intrusion.
    expect(document.documentElement.style.getPropertyValue('--kb-offset')).toBe('400px')
    act(() => { fakeViewport.height = 780; listeners['resize']?.() })
    expect(document.documentElement.style.getPropertyValue('--kb-offset')).toBe('20px')
    vi.unstubAllGlobals()
  })

  it('is a no-op without the VisualViewport API (non-mobile browsers)', () => {
    render(<Harness />)
    expect(document.documentElement.style.getPropertyValue('--kb-offset')).toBe('0px')
  })
})

describe('mobile bottom sheet', () => {
  it('renders the artifacts panel as a bottom sheet below the lg breakpoint', () => {
    // jsdom default matchMedia (stubbed false) = mobile layout.
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {} })))
    const artifacts: ArtifactRef[] = [{ id: 'a1', kind: 'code', name: 'r.md', url: '/api/files/f1/content' }]
    const { container } = render(<ArtifactsPanel artifacts={artifacts} onClose={() => {}} />)
    const aside = container.querySelector('aside')
    expect(aside?.className).toContain('bottom-0')
    expect(aside?.className).toContain('h-[85dvh]')
    expect(aside?.className).not.toContain('right-0')
    // The drag handle affordance is present in sheet mode.
    expect(container.querySelector('.rounded-full.bg-white\\/15')).not.toBeNull()
  })
})

describe('44px tap targets', () => {
  it('extends the compact composer controls with the tap-target pad', () => {
    render(
      <Composer
        input=""
        imagePreviews={[]}
        docNames={[]}
        running={false}
        runMode="auto"
        showSlash={false}
        showPlus={false}
        showModeMenu={false}
        onInputChange={vi.fn()}
        onSelectSlashCommand={vi.fn()}
        onSend={vi.fn()}
        onStop={vi.fn()}
        onImagesSelected={vi.fn()}
        onRemoveImage={vi.fn()}
        onRemoveDoc={vi.fn()}
        onTogglePlus={vi.fn()}
        onClosePlus={vi.fn()}
        onToggleModeMenu={vi.fn()}
        onCloseModeMenu={vi.fn()}
        onRunModeChange={vi.fn()}
        onOpenConnectors={vi.fn()}
        onOpenSettingsTab={vi.fn()}
        toolSelectionCount={null}
      />,
    )
    const send = screen.getByRole('button', { name: 'Send message' })
    expect(send.className).toContain('tap-target')
    const plus = screen.getByRole('button', { name: '' }) // the + attach trigger has no label
    expect(plus.textContent).toBe('')
    expect(plus.className).toContain('tap-target')
  })
})
