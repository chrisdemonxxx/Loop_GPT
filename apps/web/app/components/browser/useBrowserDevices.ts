'use client'

import { useCallback, useEffect, useState } from 'react'
import { API_URL, authHeaders } from '../../lib/api'

export interface BrowserDevice {
  id: string
  name: string
  family: 'chromium' | 'firefox' | 'tor' | 'octo'
  browserName: string
  profileLabel: string
  packageVersion: string
  online: boolean
  needsYou: { reason: string; at: string } | null
  versionSkew: boolean
  octoUuid?: string
}

export type CaptchaHandlingMode = 'wait' | 'solver'
export type SolverKeyState = 'Connected' | 'Invalid key' | 'Out of balance' | 'Unreachable' | 'Not configured'

const LAST_KEY = 'loop.browserDeviceId'

export function useBrowserDevices(active = true) {
  const [devices, setDevices] = useState<BrowserDevice[]>([])
  const [expectedVersion, setExpectedVersion] = useState('')
  const [captchaHandling, setCaptchaHandling] = useState<CaptchaHandlingMode>('wait')
  const [solverKeyState, setSolverKeyState] = useState<SolverKeyState>('Not configured')
  const [dailyCap, setDailyCap] = useState(50)
  const [solvesToday, setSolvesToday] = useState(0)
  const [ready, setReady] = useState(false)

  const refresh = useCallback(async () => {
    if (typeof fetch !== 'function') { setReady(true); return }
    try {
      const res = await fetch(`${API_URL}/api/browser/devices`, { headers: authHeaders() })
      if (!res.ok) throw new Error('devices')
      const body = await res.json()
      setDevices(Array.isArray(body.devices) ? body.devices : [])
      setExpectedVersion(typeof body.expectedVersion === 'string' ? body.expectedVersion : '')
      if (body.captchaHandling === 'wait' || body.captchaHandling === 'solver') {
        setCaptchaHandling(body.captchaHandling)
      }
      if (typeof body.solverKeyState === 'string') {
        setSolverKeyState(body.solverKeyState as SolverKeyState)
      }
      if (typeof body.dailyCap === 'number') setDailyCap(body.dailyCap)
      if (typeof body.solvesToday === 'number') setSolvesToday(body.solvesToday)
    } catch {
      setDevices([])
    } finally {
      setReady(true)
    }
  }, [])

  const updateCaptchaSettings = useCallback(async (patch: { captchaHandling?: CaptchaHandlingMode; dailyCap?: number }) => {
    if (typeof fetch !== 'function') return
    try {
      const res = await fetch(`${API_URL}/api/browser/settings`, {
        method: 'PATCH',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      })
      if (!res.ok) return
      const body = await res.json()
      if (body.captchaHandling === 'wait' || body.captchaHandling === 'solver') {
        setCaptchaHandling(body.captchaHandling)
      }
      if (typeof body.solverKeyState === 'string') {
        setSolverKeyState(body.solverKeyState as SolverKeyState)
      }
      if (typeof body.dailyCap === 'number') setDailyCap(body.dailyCap)
      if (typeof body.solvesToday === 'number') setSolvesToday(body.solvesToday)
    } catch { /* ignore */ }
  }, [])

  useEffect(() => {
    if (!active) return
    // Let a parent request that shares this tick keep the first mocked response.
    const timer = setTimeout(() => { void refresh() }, 0)
    return () => clearTimeout(timer)
  }, [active, refresh])

  return {
    devices,
    expectedVersion,
    captchaHandling,
    solverKeyState,
    dailyCap,
    solvesToday,
    ready,
    refresh,
    updateCaptchaSettings,
  }
}

export function deviceLabel(device: BrowserDevice): string {
  const profile = device.profileLabel ? ` · ${device.profileLabel}` : ''
  const skew = device.versionSkew ? ` (v${device.packageVersion || '?'} — update available)` : ''
  const needs = device.needsYou ? ' — needs you' : ''
  const offline = device.online ? '' : ' — offline'
  return `${device.name || device.browserName}${profile}${offline}${needs}${skew}`
}

export function lastBrowserDeviceId(): string {
  try { return localStorage.getItem(LAST_KEY) || '' } catch { return '' }
}

export function rememberBrowserDevice(id: string) {
  try { if (id) localStorage.setItem(LAST_KEY, id) } catch { /* private mode */ }
}

export async function releaseBrowser(source: 'chat' | 'bot' | 'build', runId?: string) {
  if (typeof fetch !== 'function') return
  await fetch(`${API_URL}/api/browser/release`, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ source, ...(runId ? { runId } : {}) }),
  }).catch(() => undefined)
}
