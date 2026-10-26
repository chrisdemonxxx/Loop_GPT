import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { BrowserRunSwitch } from '../BrowserRunSwitch'
import { BrowserConnectors, BrowserDeviceNames } from '../BrowserConnectors'
import { deviceLabel } from '../useBrowserDevices'

const fetchMock = vi.fn()

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockReset()
  window.localStorage.clear()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('Browser UI components (Chat, Build, Bot switches & Connectors)', () => {
  it('disables BrowserRunSwitch when no browser is paired', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        expectedVersion: '1.0.0',
        captchaHandling: 'wait',
        solverKeyState: 'Not configured',
        devices: [],
      }),
    })

    const onEnabled = vi.fn()
    const onDevice = vi.fn()
    render(<BrowserRunSwitch enabled={false} deviceId="" onEnabled={onEnabled} onDevice={onDevice} />)

    await waitFor(() => {
      expect(screen.getByRole('option', { name: /Pair a browser in Connectors/i })).toBeInTheDocument()
    })
    const toggle = screen.getByRole('switch', { name: /Paired browser/i })
    expect(toggle).toBeDisabled()
  })

  it('auto-selects online device, avoids duplicate DOM IDs when rendered twice, and formats deviceLabel states', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        expectedVersion: '1.0.0',
        captchaHandling: 'wait',
        solverKeyState: 'Connected',
        devices: [
          {
            id: 'brw_1',
            name: 'Work Chrome',
            family: 'chromium',
            browserName: 'Chrome',
            profileLabel: 'Work',
            packageVersion: '1.0.0',
            online: true,
            needsYou: null,
            versionSkew: false,
          },
          {
            id: 'brw_2',
            name: 'Tor Browser',
            family: 'tor',
            browserName: 'Tor Browser',
            profileLabel: '',
            packageVersion: '0.9.0',
            online: true,
            needsYou: { reason: 'captcha', at: '2026-10-25T00:00:00Z' },
            versionSkew: true,
          },
        ],
      }),
    })

    const onEnabled1 = vi.fn()
    const onDevice1 = vi.fn()
    const onEnabled2 = vi.fn()
    const onDevice2 = vi.fn()

    render(
      <div>
        <BrowserRunSwitch enabled={false} deviceId="" onEnabled={onEnabled1} onDevice={onDevice1} />
        <BrowserRunSwitch enabled={true} deviceId="brw_2" onEnabled={onEnabled2} onDevice={onDevice2} compact />
      </div>,
    )

    await waitFor(() => {
      expect(onDevice1).toHaveBeenCalledWith('brw_1')
    })

    const selects = screen.getAllByRole('combobox', { name: /Browser device/i })
    expect(selects).toHaveLength(2)
    expect(selects[0].id).not.toBe('')
    expect(selects[0].id).not.toBe(selects[1].id)

    expect(
      deviceLabel({
        id: 'brw_2',
        name: 'Tor Browser',
        family: 'tor',
        browserName: 'Tor Browser',
        profileLabel: 'Onion',
        packageVersion: '0.9.0',
        online: false,
        needsYou: { reason: 'captcha', at: '2026-10-25T00:00:00Z' },
        versionSkew: true,
      }),
    ).toBe('Tor Browser · Onion — offline — needs you (v0.9.0 — update available)')
  })

  it('renders BrowserConnectors pair code flow, captcha handling switch, and BrowserDeviceNames rename', async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const u = String(url)
      if (u.endsWith('/api/browser/devices') && (!init?.method || init.method === 'GET')) {
        return {
          ok: true,
          json: async () => ({
            expectedVersion: '1.0.0',
            captchaHandling: 'wait',
            solverKeyState: 'Connected',
            dailyCap: 50,
            solvesToday: 2,
            devices: [
              {
                id: 'brw_octo_1',
                name: 'Octo Store 1',
                family: 'octo',
                browserName: 'Chrome',
                profileLabel: 'Store 1',
                packageVersion: '1.0.0',
                online: true,
                needsYou: null,
                versionSkew: false,
              },
            ],
          }),
        }
      }
      if (u.endsWith('/api/browser/pair') && init?.method === 'POST') {
        return {
          ok: true,
          json: async () => ({
            code: 'PAIR_CODE_777',
            expiresAt: new Date(Date.now() + 600_000).toISOString(),
            expectedVersion: '1.0.0',
          }),
        }
      }
      if (u.endsWith('/api/browser/settings') && init?.method === 'PATCH') {
        return {
          ok: true,
          json: async () => ({
            captchaHandling: 'solver',
            solverKeyState: 'Connected',
            dailyCap: 50,
            solvesToday: 2,
          }),
        }
      }
      if (u.includes('/api/browser/devices/brw_octo_1') && init?.method === 'PATCH') {
        return {
          ok: true,
          json: async () => ({ device: { id: 'brw_octo_1', name: 'Renamed Octo' } }),
        }
      }
      return { ok: true, json: async () => ({ ok: true }) }
    })

    render(
      <div>
        <BrowserConnectors />
        <BrowserDeviceNames />
      </div>,
    )

    await waitFor(() => {
      expect(screen.getByText(/Octo Store 1 · Store 1/)).toBeInTheDocument()
    })
    expect(screen.getByText(/Connected/)).toBeInTheDocument()

    // Issue pair code
    fireEvent.click(screen.getByRole('button', { name: /Create pair code/i }))
    await waitFor(() => {
      expect(screen.getByText('PAIR_CODE_777')).toBeInTheDocument()
    })

    // Switch captcha handling to solver
    const captchaSelect = screen.getByRole('combobox', { name: /Captcha handling/i })
    fireEvent.change(captchaSelect, { target: { value: 'solver' } })
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/api/browser/settings'),
        expect.objectContaining({ method: 'PATCH' }),
      )
    })

    // Rename device on /agents
    const nameInput = screen.getByRole('textbox', { name: /Name Chrome/i })
    fireEvent.change(nameInput, { target: { value: 'Renamed Octo' } })
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }))
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/api/browser/devices/brw_octo_1'),
        expect.objectContaining({ method: 'PATCH' }),
      )
    })
  })
})
