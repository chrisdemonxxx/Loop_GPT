import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import SettingsPanel from '../../SettingsPanel'
import MemoryTab from '../MemoryTab'
import { I18nProvider } from '../../../lib/i18n'

// Stub fetch for the settings tabs.
const fetchMock = vi.fn()
vi.stubGlobal('fetch', fetchMock)
afterEach(() => { cleanup(); fetchMock.mockReset() })

function jsonOnce(body: any) {
  fetchMock.mockResolvedValue({ ok: true, json: async () => body })
}

describe('SettingsPanel shell', () => {
  beforeEach(() => { jsonOnce([]) }) // Skills list fetch inside the default tab
  it('has the frontier tab order and no Builder/Model tabs', () => {
    render(<SettingsPanel onClose={() => {}} />)
    const tabs = screen.getAllByRole('tab').map((t) => t.textContent?.trim())
    expect(tabs).toEqual(['Skills', 'Plugins', 'Memory', 'Personalization', 'Connectors', 'Tools'])
    expect(tabs).not.toContain('Builder')
    expect(tabs).not.toContain('Model')
    expect(tabs).not.toContain('Styles')
  })

  it('defaults to the Skills tab', () => {
    render(<SettingsPanel onClose={() => {}} />)
    expect((screen.getAllByRole('tab')[0] as HTMLElement).getAttribute('aria-selected')).toBe('true')
  })
})

describe('MemoryTab', () => {
  const rows = [
    { id: 'm1', content: 'I prefer concise answers', kind: 'explicit', source: 'user', tags: ['preference'], createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z' },
    { id: 'm2', content: 'Works at Acme on the payments team', kind: 'explicit', source: 'agent', tags: [], createdAt: '2026-09-02T00:00:00Z', updatedAt: '2026-09-02T00:00:00Z' },
  ]

  it('renders the master toggle, search, per-item edit/delete, and source badges', async () => {
    jsonOnce({ memories: rows, enabled: true })
    render(<I18nProvider><MemoryTab /></I18nProvider>)
    await waitFor(() => expect(screen.getByText('I prefer concise answers')).toBeInTheDocument())
    // Master toggle
    expect(screen.getByRole('switch', { name: 'Use memory across conversations' })).toBeInTheDocument()
    // Search
    expect(screen.getByLabelText('Search memories…')).toBeInTheDocument()
    // Source badges
    expect(screen.getByText('you added')).toBeInTheDocument()
    expect(screen.getByText('learned')).toBeInTheDocument()
    // Per-item actions
    expect(screen.getAllByLabelText('Edit memory').length).toBe(2)
    expect(screen.getAllByLabelText('Delete memory').length).toBe(2)
    // Grouping by tag (section header + badge)
    expect(screen.getAllByText('preference').length).toBeGreaterThanOrEqual(2)
  })

  it('shows the proper empty state when there are no memories', async () => {
    jsonOnce({ memories: [], enabled: true })
    render(<I18nProvider><MemoryTab /></I18nProvider>)
    await waitFor(() => expect(screen.getByText('Nothing remembered yet')).toBeInTheDocument())
    expect(screen.getByText(/Say "remember that…"/i)).toBeInTheDocument()
  })

  it('toggles memory off via the API', async () => {
    jsonOnce({ memories: rows, enabled: true })
    render(<I18nProvider><MemoryTab /></I18nProvider>)
    await waitFor(() => expect(screen.getByText('I prefer concise answers')).toBeInTheDocument())
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ enabled: false }) })
    const toggle = screen.getByRole('switch', { name: 'Use memory across conversations' })
    toggle.click()
    await waitFor(() => {
      const call = fetchMock.mock.calls.find((c: any[]) => String(c[0]).includes('/api/memory/enabled'))
      expect(call).toBeTruthy()
      expect((call![1] as any).body).toContain('"enabled":false')
    })
  })
})
