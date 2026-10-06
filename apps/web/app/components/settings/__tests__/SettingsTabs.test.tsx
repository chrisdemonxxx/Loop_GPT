import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import SettingsPanel from '../../SettingsPanel'
import MemoryTab from '../MemoryTab'
import ConnectorsTab from '../ConnectorsTab'
import ToolsTab from '../ToolsTab'
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
  it('has the blueprint (§8) panel order and no Builder/Model tabs', () => {
    render(<SettingsPanel onClose={() => {}} />)
    const tabs = screen.getAllByRole('tab').map((t) => t.textContent?.trim())
    // S2 registry (team/CONTRACT_S2_SETTINGS.md §1): Settings group then
    // Customize group; "Capabilities" maps to Tools, "Claude Code" to Loop Code.
    // Reflect was merged into Memory (redesign P1: it was a paragraph + a link).
    expect(tabs).toEqual([
      'General', 'Account', 'Privacy', 'Billing', 'Tools', 'Memory', 'Time and focus', 'Loop Code',
      'Skills', 'Connectors', 'Plugins', 'Personalization', 'Appearance',
    ])
    expect(tabs).not.toContain('Builder')
    expect(tabs).not.toContain('Model')
    expect(tabs).not.toContain('Styles')
    expect(tabs).not.toContain('Reflect')
  })

  it('renders the Settings / Customize group labels in the tab strip', () => {
    render(<SettingsPanel onClose={() => {}} />)
    const tablist = screen.getByRole('tablist')
    expect(tablist.textContent).toContain('Settings')
    expect(tablist.textContent).toContain('Customize')
  })

  it('defaults to the General tab', () => {
    render(<SettingsPanel onClose={() => {}} />)
    const general = screen.getByRole('tab', { name: /General/ }) as HTMLElement
    expect(general.getAttribute('aria-selected')).toBe('true')
  })

  it('derives the panel from a #settings/<panel> deep link on mount', () => {
    window.location.hash = '#settings/billing'
    try {
      render(<SettingsPanel onClose={() => {}} />)
      const billing = screen.getByRole('tab', { name: 'Billing' }) as HTMLElement
      expect(billing.getAttribute('aria-selected')).toBe('true')
      expect(screen.getByText('Current plan')).toBeInTheDocument()
    } finally {
      window.location.hash = ''
    }
  })

  it('derives the privacy sub-panel from #settings/privacy/<sub>', async () => {
    window.location.hash = '#settings/privacy/shared-chats'
    try {
      render(<SettingsPanel onClose={() => {}} />)
      expect(screen.getByText('Shared chats')).toBeInTheDocument()
      // The sub-panel's back affordance targets the Privacy root.
      expect(screen.getByRole('button', { name: 'Privacy' })).toBeInTheDocument()
    } finally {
      window.location.hash = ''
    }
  })

  it('selecting a tab pushes the settings hash; leaving it fires onClose', () => {
    window.location.hash = ''
    const onClose = vi.fn()
    render(<SettingsPanel onClose={onClose} />)
    fireEvent.click(screen.getByRole('tab', { name: 'Memory' }))
    expect(window.location.hash).toBe('#settings/memory')
    // Simulate browser back (hash empties): the panel closes through onClose.
    expect(onClose).not.toHaveBeenCalled()
    window.location.hash = ''
    fireEvent(window, new HashChangeEvent('hashchange'))
    expect(onClose).toHaveBeenCalledOnce()
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

describe('SettingsPanel close and open paths', () => {
  beforeEach(() => { jsonOnce([]) })

  it('closes from the X, the backdrop, and Escape, but not from a click inside', () => {
    const onClose = vi.fn()
    const { container } = render(<SettingsPanel onClose={onClose} />)
    fireEvent.click(screen.getByRole('button', { name: 'Close settings' }))
    expect(onClose).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(2)
    const backdrop = container.querySelector('.fixed.inset-0') as HTMLElement
    fireEvent.click(backdrop)
    expect(onClose).toHaveBeenCalledTimes(3)
    onClose.mockClear()
    fireEvent.click(screen.getByRole('dialog', { name: 'Agent settings' }))
    expect(onClose).not.toHaveBeenCalled()
  })

  it('lands on the tab callers pass as initialTab', async () => {
    render(<SettingsPanel onClose={() => {}} initialTab="memory" />)
    const memory = screen.getAllByRole('tab').find((t) => t.textContent?.includes('Memory'))
    expect(memory?.getAttribute('aria-selected')).toBe('true')
    expect(memory?.className).toContain('border-[#c96442]')
    await waitFor(() => expect(screen.getByText('Nothing remembered yet')).toBeInTheDocument())
  })

  it('scrolls inside the dialog and keeps the tab row on one line above the safe area', () => {
    const { container } = render(<SettingsPanel onClose={() => {}} />)
    const tablist = screen.getByRole('tablist')
    expect(tablist.className).toContain('overflow-x-auto')
    expect(tablist.className).toContain('flex-nowrap')
    const body = container.querySelector('.overflow-y-auto') as HTMLElement
    expect(body.className).toContain('min-h-0')
    expect(body.className).toContain('safe-area-inset-bottom')
    const backdrop = container.querySelector('.fixed.inset-0') as HTMLElement
    expect(backdrop.className).toContain('safe-area-inset-bottom')
  })
})

describe('failed list loads', () => {
  it('does not show the memory empty state when the list fails, and retry refetches', async () => {
    fetchMock.mockRejectedValueOnce(new Error('offline'))
    render(<I18nProvider><MemoryTab /></I18nProvider>)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument())
    expect(screen.queryByText('Nothing remembered yet')).not.toBeInTheDocument()
    expect(screen.getByText('Could not load memories.')).toBeInTheDocument()
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ memories: [], enabled: true }) })
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(screen.getByText('Nothing remembered yet')).toBeInTheDocument())
    expect(screen.queryByText('Could not load memories.')).not.toBeInTheDocument()
  })

  it('keeps a failed memory save in the draft', async () => {
    jsonOnce({ memories: [], enabled: true })
    render(<I18nProvider><MemoryTab /></I18nProvider>)
    const input = await screen.findByLabelText('New memory')
    fireEvent.change(input, { target: { value: 'keep this memory' } })
    fetchMock.mockResolvedValueOnce({ ok: false, json: async () => ({ error: 'Could not save.' }) })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    await waitFor(() => expect(screen.getByText('Could not save.')).toBeInTheDocument())
    expect((input as HTMLInputElement).value).toBe('keep this memory')
  })

  it('uses the connectors empty copy only after a successful empty load', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ types: [], configured: [], marketplace: [] }) })
    render(<ConnectorsTab workspaceId={null} />)
    await waitFor(() => expect(screen.getByText('Nothing connected yet')).toBeInTheDocument())
  })

  it('does not treat a failed connectors load as empty', async () => {
    fetchMock.mockRejectedValueOnce(new Error('offline'))
    render(<ConnectorsTab workspaceId="ws-1" />)
    await waitFor(() => expect(screen.getByText('Could not load connectors.')).toBeInTheDocument())
    expect(screen.queryByText('Nothing connected yet')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
  })

  it('does not start OAuth when workspaceId is null', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        types: [{ type: 'github', name: 'GitHub', description: 'Repos', category: 'Code', icon: null, oauth: true, fields: [] }],
        configured: [],
        marketplace: [],
      }),
    })
    render(<ConnectorsTab workspaceId={null} />)
    const connect = await screen.findByRole('button', { name: 'Connect with GitHub' })
    const callsBefore = fetchMock.mock.calls.length
    fireEvent.click(connect)
    await waitFor(() => expect(screen.getByText('Open a project first (Projects in the sidebar), then connect.')).toBeInTheDocument())
    const oauthCalls = fetchMock.mock.calls.slice(callsBefore).filter((c) => String(c[0]).includes('oauth-connector'))
    expect(oauthCalls).toHaveLength(0)
  })

  it('keeps the exact sign-in failure string', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (String(url).includes('oauth-connector')) return Promise.reject(new Error('network'))
      return Promise.resolve({
        ok: true,
        json: async () => ({
          types: [{ type: 'github', name: 'GitHub', description: 'Repos', category: 'Code', icon: null, oauth: true, fields: [] }],
          configured: [],
          marketplace: [],
        }),
      })
    })
    render(<ConnectorsTab workspaceId="ws-1" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Connect with GitHub' }))
    await waitFor(() => expect(screen.getByText('Could not start the sign-in flow.')).toBeInTheDocument())
  })

  it('keeps a failed connector draft', async () => {
    const catalog = {
      types: [{ type: 'sentry', name: 'Sentry', description: 'Errors', category: 'Code', icon: null, oauth: false, fields: [{ key: 'token', label: 'Token', secret: true }] }],
      configured: [],
      marketplace: [],
    }
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return Promise.resolve({ ok: false, json: async () => ({ error: 'Could not connect.' }) })
      return Promise.resolve({ ok: true, json: async () => catalog })
    })
    render(<ConnectorsTab workspaceId="ws-1" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Add' }))
    const token = await screen.findByLabelText('Token')
    fireEvent.change(token, { target: { value: 'secret-token' } })
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
    await waitFor(() => expect(screen.getAllByText('Could not connect.').length).toBeGreaterThan(0))
    expect((screen.getByLabelText('Token') as HTMLInputElement).value).toBe('secret-token')
  })
})

describe('review fixes', () => {
  const memoryRows = [
    { id: 'm1', content: 'I prefer concise answers', kind: 'explicit', source: 'user', tags: ['preference'], createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z' },
  ]

  it('Escape closes a nested connector dialog without closing Agent settings', async () => {
    const onClose = vi.fn()
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        types: [],
        configured: [],
        marketplace: [{ type: 'slack', name: 'Slack', docs: null }],
      }),
    })
    render(<SettingsPanel onClose={onClose} initialTab="connectors" workspaceId="ws-1" />)
    fireEvent.click(await screen.findByRole('button', { name: /Marketplace/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'Add to my apps' }))
    expect(await screen.findByRole('dialog', { name: 'Connect Slack' })).toBeInTheDocument()
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Connect Slack' })).not.toBeInTheDocument())
    expect(screen.getByRole('dialog', { name: 'Agent settings' })).toBeInTheDocument()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('Escape while editing a memory cancels the edit and leaves the panel open', async () => {
    const onClose = vi.fn()
    jsonOnce({ memories: memoryRows, enabled: true })
    render(<SettingsPanel onClose={onClose} initialTab="memory" />)
    await screen.findByText('I prefer concise answers')
    fireEvent.click(screen.getByRole('button', { name: 'Edit memory' }))
    const input = screen.getByRole('textbox', { name: 'Edit memory' })
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.queryByRole('textbox', { name: 'Edit memory' })).not.toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: 'Agent settings' })).toBeInTheDocument()
    expect(screen.getByText('I prefer concise answers')).toBeInTheDocument()
  })

  it('keeps the previous memory toggle when the save fails', async () => {
    jsonOnce({ memories: [], enabled: true })
    render(<I18nProvider><MemoryTab /></I18nProvider>)
    const toggle = await screen.findByRole('switch', { name: 'Use memory across conversations' })
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    fetchMock.mockResolvedValueOnce({ ok: false, json: async () => ({ error: 'Could not save.' }) })
    fireEvent.click(toggle)
    await waitFor(() => expect(screen.getByText('Could not save.')).toBeInTheDocument())
    expect(toggle.getAttribute('aria-checked')).toBe('true')
  })

  it('keeps the previous tool permission when the save fails', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        tools: [{ name: 'web_search', description: 'Search', source: 'builtin', default: 'allow', effective: 'allow' }],
        permissions: {},
      }),
    })
    render(<ToolsTab />)
    const select = await screen.findByLabelText('Permission for web_search') as HTMLSelectElement
    expect(select.value).toBe('allow')
    fetchMock.mockResolvedValueOnce({ ok: false, json: async () => ({ error: 'Could not save.' }) })
    fireEvent.change(select, { target: { value: 'blocked' } })
    await waitFor(() => expect(screen.getByText('Could not save.')).toBeInTheDocument())
    expect(select.value).toBe('allow')
  })

  it('always shows the sign-in failure sentence, ignoring a server error', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (String(url).includes('oauth-connector')) {
        return Promise.resolve({ ok: false, json: async () => ({ error: 'provider down' }) })
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({
          types: [{ type: 'github', name: 'GitHub', description: 'Repos', category: 'Code', icon: null, oauth: true, fields: [] }],
          configured: [],
          marketplace: [],
        }),
      })
    })
    render(<ConnectorsTab workspaceId="ws-1" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Connect with GitHub' }))
    await waitFor(() => expect(screen.getByText('Could not start the sign-in flow.')).toBeInTheDocument())
    expect(screen.queryByText('provider down')).not.toBeInTheDocument()
  })

  it('does not mention plan usage or link to account on Appearance', async () => {
    render(<SettingsPanel onClose={() => {}} initialTab="appearance" />)
    expect(await screen.findByRole('radio', { name: /Dark/ })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: /Light/ })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: /System/ })).toBeInTheDocument()
    expect(screen.queryByText(/plan usage/i)).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /account/i })).not.toBeInTheDocument()
    expect(document.querySelector('a[href="/account"]')).toBeNull()
  })
})
