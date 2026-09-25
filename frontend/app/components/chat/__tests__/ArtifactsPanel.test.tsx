import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import ArtifactsPanel from '../ArtifactsPanel'
import type { ArtifactRef } from '../../../lib/stream'

/** Right-hand artifacts panel (audit P2): focused view + back-to-list,
 * list→focus flow, building placeholders, sandbox error bridge → Fix error. */

const art = (over: Partial<ArtifactRef>): ArtifactRef => ({ id: 'a1', kind: 'code', name: 'report.md', ...over })

const artifacts: ArtifactRef[] = [
  art({ id: 'a1', kind: 'code', name: 'report.md', url: '/api/files/f1/content' }),
  art({ id: 'a2', kind: 'html', name: 'site.html', url: '/api/files/f2/content' }),
  art({ id: 'a3', kind: 'xlsx', name: 'budget.xlsx', url: '/api/files/f3/content' }),
]

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, text: async () => 'file body', arrayBuffer: async () => new ArrayBuffer(0), json: async () => ({}) })))
  // jsdom has no matchMedia; the panel's desktop-width hook (and
  // framer-motion's reduced-motion listener) need it.
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {} })))
  localStorage.clear()
})
afterEach(() => vi.unstubAllGlobals())

function renderPanel(overrides: Partial<Parameters<typeof ArtifactsPanel>[0]> = {}) {
  const onFixError = vi.fn()
  const props = {
    artifacts,
    onClose: vi.fn(),
    onBackToList: vi.fn(),
    onFocusArtifact: vi.fn(),
    onFixError,
    ...overrides,
  }
  const result = render(<ArtifactsPanel {...props} />)
  return { ...result, props, onFixError }
}

describe('ArtifactsPanel — list and focus', () => {
  it('lists artifacts and focuses one via the list click', () => {
    const { props } = renderPanel()
    expect(screen.getByText('report.md')).toBeInTheDocument()
    fireEvent.click(screen.getByText('report.md'))
    expect(props.onFocusArtifact).toHaveBeenCalledWith('a1')
  })

  it('renders the focused view with a back-to-list control', () => {
    const { props } = renderPanel({ focusId: 'a2' })
    expect(screen.getByText('site.html')).toBeInTheDocument()
    fireEvent.click(screen.getByTitle('Back to list'))
    expect(props.onBackToList).toHaveBeenCalledOnce()
  })

  it('shows per-artifact Building… placeholders for in-flight tools', () => {
    renderPanel({ buildingKinds: ['generate_image', 'create_document'] })
    expect(screen.getByText('Generating image…')).toBeInTheDocument()
    expect(screen.getByText('Building document…')).toBeInTheDocument()
  })
})

describe('ArtifactsPanel — sandbox error bridge', () => {
  it('surfaces sandbox errors and dispatches the Fix-error prompt', async () => {
    const { onFixError } = renderPanel({ focusId: 'a2' })
    // Switch to the Sandbox tab for the HTML artifact.
    fireEvent.click(screen.getByRole('button', { name: 'Sandbox' }))
    // The previewed document posts an uncaught error back to the panel.
    fireEvent(window, new MessageEvent('message', { data: { __artifactError: 'undefined is not a function' } }))
    expect(await screen.findByText(/undefined is not a function/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /fix error/i }))
    expect(onFixError).toHaveBeenCalledOnce()
    const prompt = onFixError.mock.calls[0][0] as string
    expect(prompt).toContain('site.html')
    expect(prompt).toContain('undefined is not a function')
    expect(prompt).toContain('file body') // the artifact source rides along
  })

  it('clears the sandbox error state when switching tabs', async () => {
    renderPanel({ focusId: 'a2' })
    fireEvent.click(screen.getByRole('button', { name: 'Sandbox' }))
    fireEvent(window, new MessageEvent('message', { data: { __artifactError: 'boom' } }))
    expect(await screen.findByText(/boom/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }))
    await waitFor(() => expect(screen.queryByText(/boom/)).not.toBeInTheDocument())
  })
})
