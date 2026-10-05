import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import DownloadsPage from '../downloads/page'
import UpgradePage from '../upgrade/page'
import BuyingSpecialistPage from '../buying-specialist/page'
import LogoutPage from '../logout/page'
import NewChatRedirect from '../new/page'
import CodeRedirect from '../code/page'
import CodeArtifactsRedirect from '../code/artifacts/page'
import CodeCustomizeRedirect from '../code/customize/page'

const replaceMock = vi.fn()
const fetchMock = vi.fn()
beforeEach(() => {
  vi.stubGlobal('location', { replace: replaceMock, href: '', search: '', hash: '' })
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockReset()
})
afterEach(() => { cleanup(); replaceMock.mockClear(); vi.unstubAllGlobals() })

describe('S3 route group 2 (CONTRACT_S3_ROUTES)', () => {
  it('/downloads: real PWA install section, honest not-shipped copy, no fake store links', () => {
    render(<DownloadsPage />)
    expect(screen.getByRole('heading', { name: /everywhere you work/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Install/ })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Mobile' })).toHaveTextContent(/in development/i)
    expect(screen.getByRole('region', { name: 'Browser extension' })).toHaveTextContent(/not shipped yet/i)
    // the CLI hand-off is our real developer surface
    expect(screen.getByRole('link', { name: /Open Loop Code/ })).toHaveAttribute('href', '/developer')
  })

  it('/upgrade: blueprint §9.7 structure — audience radios, three tiers, frozen truth, voucher path', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (String(url).includes('/api/billing/config')) {
        return Promise.resolve({ ok: true, json: async () => ({ enabled: false, checkoutEnabled: false }) })
      }
      if (String(url).includes('/api/account/me')) {
        return Promise.resolve({ ok: true, json: async () => ({ plan: 'free', credits: 30 }) })
      }
      return Promise.resolve({ ok: true, json: async () => ({}) })
    })
    render(<UpgradePage />)
    // audience radiogroup
    const individual = screen.getByRole('radio', { name: 'Individual' })
    expect(individual).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(screen.getByRole('radio', { name: 'Team and Enterprise' }))
    expect(screen.getByRole('region', { name: 'Team plan' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Enterprise plan' })).toBeInTheDocument()
    fireEvent.click(individual)
    // our real plan ids, current marked (arrives async with /me)
    await waitFor(() => expect(screen.getByRole('region', { name: /Free plan/ })).toHaveTextContent(/current/))
    expect(screen.getByRole('region', { name: /Pro plan/ })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: /Gold plan/ })).toBeInTheDocument()
    // frozen truth + voucher path to the billing panel
    await waitFor(() => expect(screen.getByRole('note')).toHaveTextContent(/not enabled yet/i))
    expect(screen.getByRole('link', { name: /Billing/ })).toHaveAttribute('href', '/customize#settings/billing')
  })

  it('/buying-specialist: honest contact shell, no fake chat UI', () => {
    render(<BuyingSpecialistPage />)
    expect(screen.getByRole('heading', { name: /buying specialist/i })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Email the buying specialist/ })).toHaveAttribute('href', expect.stringContaining('mailto:sales@loop-gpt.cyou'))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('/logout clears the session token and lands on /login', async () => {
    window.localStorage.setItem('authToken', 'fixture-token')
    render(<LogoutPage />)
    await waitFor(() => expect(replaceMock).toHaveBeenCalledWith('/login'))
    expect(window.localStorage.getItem('authToken')).toBeNull()
  })

  it.each([
    [NewChatRedirect, '/chat', 'new chat'],
    [CodeRedirect, '/developer', 'Loop Code'],
    [CodeArtifactsRedirect, '/artifacts', 'artifacts'],
    [CodeCustomizeRedirect, '/customize', 'customize'],
  ])('blueprint alias routes redirect to the real surface ($2)', async (Page, target) => {
    render(<Page />)
    await waitFor(() => expect(replaceMock).toHaveBeenCalledWith(target))
  })
})