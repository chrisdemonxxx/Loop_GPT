import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { AccountAppsPanel } from '../AccountAppsPanel'

describe('AccountAppsPanel', () => {
  it('lists connected and available apps and connects or disconnects through the existing routes', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const path = String(url)
      if (path.includes('/api/agent/connectors') && (!init || init.method === undefined || init.method === 'GET')) {
        return {
          ok: true,
          json: async () => ({
            types: [
              { type: 'github', name: 'GitHub', oauth: false, description: 'Repos' },
              { type: 'slack', name: 'Slack', oauth: true, description: 'Channels' },
            ],
            configured: [{ id: 'c1', type: 'github', name: 'GitHub', enabled: true }],
            marketplace: [],
          }),
        }
      }
      return { ok: true, json: async () => ({ authorizeUrl: 'https://example.test/oauth', id: 'new' }) }
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<AccountAppsPanel apiUrl="https://api.test" authHeaders={() => ({ Authorization: 'Bearer t' })} />)
    expect(await screen.findByText('Connected')).toBeInTheDocument()
    expect(screen.getByText('GitHub')).toBeInTheDocument()
    expect(screen.getByText('Available')).toBeInTheDocument()
    expect(screen.getByText('Slack')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Disconnect GitHub' }))
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('https://api.test/api/agent/connectors/c1', expect.objectContaining({ method: 'DELETE' }))
    })

    fireEvent.click(screen.getByRole('button', { name: 'Connect Slack' }))
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('https://api.test/api/oauth-connector/init/slack', expect.objectContaining({ method: 'POST' }))
    })
    vi.unstubAllGlobals()
  })
})
