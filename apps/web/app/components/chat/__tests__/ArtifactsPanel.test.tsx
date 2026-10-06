import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
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

function failedResponse() {
  return { ok: false, text: async () => '', blob: async () => new Blob(), arrayBuffer: async () => new ArrayBuffer(0), json: async () => ({}) }
}
function okResponse(body = 'file body') {
  return { ok: true, text: async () => body, blob: async () => new Blob([body]), arrayBuffer: async () => new ArrayBuffer(0), json: async () => ({}) }
}

describe('ArtifactsPanel ? open, download, publish, compare failures', () => {
  it('failed open is not the empty list or a shimmer, and Retry refetches the same URL', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => failedResponse())
    vi.stubGlobal('fetch', fetchMock)
    const { props, container } = renderPanel({ focusId: 'a1' })
    expect(await screen.findByText("Couldn't open this file.")).toBeInTheDocument()
    expect(screen.queryByText('Generated files and code snippets appear here as the agent creates them.')).not.toBeInTheDocument()
    expect(screen.queryByText(/Loading/)).not.toBeInTheDocument()
    expect(container.querySelector('.shimmer')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Raw' }))
    expect(screen.getByText("Couldn't open this file.")).toBeInTheDocument()
    const url = String(fetchMock.mock.calls[0][0])
    expect(url).toContain('/api/files/f1/content')
    fetchMock.mockResolvedValueOnce(okResponse())
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('file body')).toBeInTheDocument()
    expect(String(fetchMock.mock.calls.at(-1)?.[0])).toBe(url)
    expect(screen.getByText('report.md')).toBeInTheDocument()
    expect(props.onBackToList).not.toHaveBeenCalled()
  })

  it('a failed image open is not a stuck shimmer and Retry stays on that file', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => failedResponse())
    vi.stubGlobal('fetch', fetchMock)
    URL.createObjectURL = () => 'blob:pic'
    URL.revokeObjectURL = () => {}
    const { container } = renderPanel({
      focusId: 'img',
      artifacts: [art({ id: 'img', kind: 'image', name: 'pic.png', url: '/api/files/img/content' })],
    })
    expect(await screen.findByText("Couldn't open this file.")).toBeInTheDocument()
    expect(container.querySelector('.shimmer')).toBeNull()
    expect(screen.queryByText(/Loading/)).not.toBeInTheDocument()
    const url = String(fetchMock.mock.calls[0][0])
    fetchMock.mockResolvedValueOnce(okResponse('img'))
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByAltText('pic.png')).toBeInTheDocument()
    expect(String(fetchMock.mock.calls.at(-1)?.[0])).toBe(url)
    expect(screen.getByText('pic.png')).toBeInTheDocument()
  })

  it('a failed pdf open offers Retry for the same content URL', async () => {
    const urls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => { urls.push(String(url)); return failedResponse() }))
    renderPanel({
      focusId: 'pdf1',
      artifacts: [art({ id: 'pdf1', kind: 'pdf', name: 'notes.pdf', url: '/api/files/pdf1/content' })],
    })
    expect(await screen.findByText("Couldn't open this file.")).toBeInTheDocument()
    expect(screen.queryByText(/Loading/)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(urls.length).toBeGreaterThan(1))
    expect(urls.every((u) => u === urls[0])).toBe(true)
    expect(urls[0]).toContain('/api/files/pdf1/content')
    expect(screen.getByText('notes.pdf')).toBeInTheDocument()
  })

  it('a failed sheet open offers Retry for the same content URL', async () => {
    const urls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => { urls.push(String(url)); return failedResponse() }))
    renderPanel({ focusId: 'a3' })
    expect(await screen.findByText("Couldn't open this file.")).toBeInTheDocument()
    expect(screen.queryByText('Could not read this spreadsheet.')).not.toBeInTheDocument()
    expect(screen.queryByText(/Loading/)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(urls.length).toBeGreaterThan(1))
    expect(urls.every((u) => u === urls[0])).toBe(true)
    expect(urls[0]).toContain('/api/files/f3/content')
    expect(screen.getByText('budget.xlsx')).toBeInTheDocument()
  })

  it('a failed download shows one error and does not clear a fix-error prefill', async () => {
    let phase: 'ok' | 'fail' = 'ok'
    vi.stubGlobal('fetch', vi.fn(async () => (phase === 'ok' ? okResponse() : failedResponse())))
    let draft = ''
    const onFixError = vi.fn((prompt: string) => { draft = prompt })
    renderPanel({ focusId: 'a2', onFixError })
    fireEvent.click(screen.getByRole('button', { name: 'Sandbox' }))
    expect(await screen.findByTitle('Sandbox: site.html')).toBeInTheDocument()
    fireEvent(window, new MessageEvent('message', { data: { __artifactError: 'undefined is not a function' } }))
    fireEvent.click(await screen.findByRole('button', { name: /fix error/i }))
    const prefilled = draft
    expect(prefilled).toContain('file body')
    phase = 'fail'
    fireEvent.click(screen.getByRole('button', { name: 'Download' }))
    expect(await screen.findByText('Could not download this file.')).toBeInTheDocument()
    expect(screen.getAllByText('Could not download this file.')).toHaveLength(1)
    expect(draft).toBe(prefilled)
    expect(onFixError).toHaveBeenCalledOnce()
    expect(screen.queryByText(/downloaded/i)).not.toBeInTheDocument()
  })

  it('a failed publish shows one error, no link, and does not clear a prefill', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('/publish')) return failedResponse()
      return okResponse()
    }))
    let draft = 'prefilled from fix error'
    const onFixError = vi.fn((prompt: string) => { draft = prompt })
    renderPanel({ focusId: 'a1', onFixError })
    fireEvent.click(screen.getByRole('button', { name: 'Publish link' }))
    expect(await screen.findByText('Could not publish this file.')).toBeInTheDocument()
    expect(screen.getAllByText('Could not publish this file.')).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'Publish link' })).toBeInTheDocument()
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
    expect(draft).toBe('prefilled from fix error')
    expect(onFixError).not.toHaveBeenCalled()
  })

  it('a failed unpublish keeps the link that is already shown', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const method = (init?.method || 'GET').toUpperCase()
      if (String(url).includes('/publish') && method === 'DELETE') return failedResponse()
      if (String(url).includes('/publish')) return { ok: true, json: async () => ({ url: 'https://share.example/p' }), text: async () => '', blob: async () => new Blob(), arrayBuffer: async () => new ArrayBuffer(0) }
      return okResponse()
    }))
    renderPanel({ focusId: 'a1' })
    fireEvent.click(screen.getByRole('button', { name: 'Publish link' }))
    expect(await screen.findByRole('link', { name: 'https://share.example/p' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Unpublish' }))
    expect(await screen.findByText('Could not unpublish this file.')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'https://share.example/p' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Unpublish' })).toBeInTheDocument()
  })

  it('compare that cannot read a version shows the failure instead of a blank diff', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL) => failedResponse()))
    renderPanel({
      artifacts: [
        art({ id: 'v1', name: 'report.md', url: '/api/files/v1/content' }),
        art({ id: 'v2', name: 'report_v2.md', url: '/api/files/v2/content' }),
      ],
    })
    fireEvent.click(screen.getByRole('button', { name: /Compare 2 versions/ }))
    expect(await screen.findByText("Couldn't open this file.")).toBeInTheDocument()
    expect(screen.queryByTestId('version-diff')).not.toBeInTheDocument()
    expect(screen.queryByText('Generated files and code snippets appear here as the agent creates them.')).not.toBeInTheDocument()
  })

  it('a focus id that is not in the list returns to the list', () => {
    renderPanel({ focusId: 'missing' })
    expect(screen.getByText('Artifacts')).toBeInTheDocument()
    expect(screen.getByText('report.md')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Preview' })).not.toBeInTheDocument()
    expect(screen.queryByText('missing')).not.toBeInTheDocument()
  })

  it('keeps the empty sentence when nothing is building', () => {
    renderPanel({ artifacts: [], buildingKinds: [] })
    expect(screen.getByText('Generated files and code snippets appear here as the agent creates them.')).toBeInTheDocument()
  })

  it('the sandbox iframe does not allow same origin', async () => {
    renderPanel({ focusId: 'a2' })
    fireEvent.click(screen.getByRole('button', { name: 'Sandbox' }))
    const frame = await screen.findByTitle('Sandbox: site.html')
    expect(frame).toHaveAttribute('sandbox', 'allow-scripts allow-popups allow-forms')
    expect(frame.getAttribute('sandbox')).not.toContain('allow-same-origin')
  })
})

describe('ArtifactsPanel ? raw failure and sandbox refetch', () => {
  it.each([
    ['image', art({ id: 'img', kind: 'image', name: 'pic.png', url: '/api/files/img/content' })],
    ['pdf', art({ id: 'pdf1', kind: 'pdf', name: 'notes.pdf', url: '/api/files/pdf1/content' })],
    ['sheet', art({ id: 'sheet1', kind: 'xlsx', name: 'budget.xlsx', url: '/api/files/f3/content' })],
    ['mermaid', art({ id: 'm1', kind: 'mermaid', name: 'diagram.mmd', url: '/api/files/m1/content' })],
  ])('raw shows the open failure for %s and retries that content URL', async (_kind, item) => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => failedResponse())
    vi.stubGlobal('fetch', fetchMock)
    const { props, container } = renderPanel({ focusId: item.id, artifacts: [item] })
    expect(await screen.findByText("Couldn't open this file.")).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Raw' }))
    expect(screen.getByText("Couldn't open this file.")).toBeInTheDocument()
    expect(container.querySelector('pre')).toBeNull()
    const url = String(fetchMock.mock.calls[0][0])
    expect(url).toContain(item.url)
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(1))
    expect(fetchMock.mock.calls.every((call) => String(call[0]) === url)).toBe(true)
    expect(screen.getByText("Couldn't open this file.")).toBeInTheDocument()
    expect(container.querySelector('pre')).toBeNull()
    expect(screen.getByText(item.name)).toBeInTheDocument()
    expect(props.onBackToList).not.toHaveBeenCalled()
  })

  it('shows loading instead of the previous sandbox document while a refetch is in flight', async () => {
    const pending: Array<(value: ReturnType<typeof okResponse>) => void> = []
    vi.stubGlobal('fetch', vi.fn(() => new Promise((resolve) => { pending.push(resolve) })))
    const view = renderPanel({
      focusId: 'a2',
      artifacts: [art({ id: 'a2', kind: 'html', name: 'site.html', url: '/api/files/f2/content' })],
    })
    await waitFor(() => expect(pending.length).toBeGreaterThan(0))
    await act(async () => { pending[0](okResponse('<p>old document</p>')) })
    fireEvent.click(screen.getByRole('button', { name: 'Sandbox' }))
    const frame = await screen.findByTitle('Sandbox: site.html')
    expect(frame.getAttribute('srcdoc')).toContain('old document')
    expect(frame.getAttribute('sandbox')).not.toContain('allow-same-origin')
    view.rerender(
      <ArtifactsPanel
        {...view.props}
        focusId="a2"
        artifacts={[art({ id: 'a2', kind: 'html', name: 'site.html', url: '/api/files/f2b/content' })]}
      />,
    )
    await waitFor(() => expect(pending.length).toBeGreaterThan(1))
    expect(screen.queryByTitle('Sandbox: site.html')).not.toBeInTheDocument()
    expect(screen.getByText(/Loading/)).toBeInTheDocument()
    expect(document.body.innerHTML).not.toContain('old document')
    await act(async () => { pending[1](okResponse('<p>new document</p>')) })
    const next = await screen.findByTitle('Sandbox: site.html')
    expect(next.getAttribute('srcdoc')).toContain('new document')
    expect(next.getAttribute('srcdoc')).not.toContain('old document')
    expect(next).toHaveAttribute('sandbox', 'allow-scripts allow-popups allow-forms')
    expect(next.getAttribute('sandbox')).not.toContain('allow-same-origin')
  })
})
