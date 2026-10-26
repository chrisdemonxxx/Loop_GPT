'use client'

import { useState } from 'react'
import Link from 'next/link'
import { API_URL, authHeaders } from '../../lib/api'
import { deviceLabel, useBrowserDevices, type CaptchaHandlingMode } from './useBrowserDevices'

/** Pairing group on Settings → Connectors. Naming stays on /agents. */
export function BrowserConnectors() {
  const {
    devices,
    expectedVersion,
    captchaHandling,
    solverKeyState,
    dailyCap,
    solvesToday,
    refresh,
    updateCaptchaSettings,
  } = useBrowserDevices()
  const [code, setCode] = useState('')
  const [expires, setExpires] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const issue = async () => {
    setBusy(true)
    setError('')
    try {
      const res = await fetch(`${API_URL}/api/browser/pair`, { method: 'POST', headers: authHeaders() })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error || 'Could not create a pair code.')
      setCode(body.code || '')
      setExpires(body.expiresAt || '')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not create a pair code.')
    } finally {
      setBusy(false)
    }
  }

  const unpair = async (id: string) => {
    await fetch(`${API_URL}/api/browser/devices/${id}`, { method: 'DELETE', headers: authHeaders() }).catch(() => undefined)
    await refresh()
  }

  return (
    <section aria-label="Browsers" className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-tint)] p-3 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium text-[var(--ink-primary)]">Browsers</h3>
        <button type="button" onClick={() => { void issue() }} disabled={busy} className="text-ui-xs text-[var(--accent-text)] hover:underline disabled:opacity-50">
          {busy ? 'Creating…' : 'Create pair code'}
        </button>
      </div>
      <p className="text-xs text-[var(--ink-muted)] leading-relaxed">
        Install the extension, click Connect in that browser, and approve the prompt.
        Login and captcha pause in the visible window until you continue.
        Name a device on <Link href="/agents" className="text-[var(--accent-text)] hover:underline">Agents</Link>.
        Install notes are on <Link href="/downloads" className="text-[var(--accent-text)] hover:underline">Downloads</Link>.
      </p>
      {code && (
        <p className="text-xs text-[var(--ink-secondary)]">
          Pair code <span className="font-mono text-[var(--ink-primary)]">{code}</span>
          {expires ? ` · expires ${new Date(expires).toLocaleTimeString()}` : ''}
          {expectedVersion ? ` · package ${expectedVersion}` : ''}
        </p>
      )}
      {error && <p className="text-xs text-[var(--danger)]">{error}</p>}
      {devices.map((device) => (
        <div key={device.id} className="flex items-center gap-2 text-xs">
          <span className={`h-1.5 w-1.5 rounded-full ${device.online ? 'bg-emerald-400' : 'bg-slate-500'}`} aria-hidden />
          <span className="min-w-0 flex-1 truncate text-[var(--ink-secondary)]">{deviceLabel(device)}</span>
          <button type="button" onClick={() => { void unpair(device.id) }} className="text-[var(--ink-muted)] hover:text-[var(--danger)]">Unpair</button>
        </div>
      ))}
      {devices.length === 0 && <p className="text-xs text-[var(--ink-muted)]">No browser paired yet.</p>}
      <div className="pt-2 border-t border-[var(--border-subtle)] flex flex-wrap items-center justify-between gap-2 text-xs">
        <div className="flex items-center gap-2">
          <span className="text-[var(--ink-secondary)]">Captcha handling:</span>
          <select
            aria-label="Captcha handling"
            value={captchaHandling}
            onChange={(event) => {
              void updateCaptchaSettings({ captchaHandling: event.target.value as CaptchaHandlingMode })
            }}
            className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-base)] px-2 py-0.5 text-xs text-[var(--ink-primary)]"
          >
            <option value="wait">Wait in browser window</option>
            <option value="solver">Use BYOK solver key</option>
          </select>
        </div>
        <span className="text-[var(--ink-muted)]">
          Solver key: <strong className="font-normal text-[var(--ink-secondary)]">{solverKeyState}</strong>
          {captchaHandling === 'solver' ? ` · ${solvesToday}/${dailyCap} today` : ''}
        </span>
      </div>
    </section>
  )
}

/** Rename paired devices. Unpairing removes a device from every picker. */
export function BrowserDeviceNames() {
  const { devices, refresh } = useBrowserDevices()
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  if (!devices.length) return null
  return (
    <section aria-label="Browser names" className="mb-4">
      <h3 className="text-2xs uppercase tracking-widest text-[var(--ink-muted)] font-medium mb-2">Browsers</h3>
      <div className="space-y-2">
        {devices.map((device) => (
          <form
            key={device.id}
            className="flex items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault()
              const name = (drafts[device.id] ?? device.name).trim()
              if (!name) return
              void fetch(`${API_URL}/api/browser/devices/${device.id}`, {
                method: 'PATCH',
                headers: { ...authHeaders(), 'Content-Type': 'application/json' },
                body: JSON.stringify({ name }),
              }).then(() => refresh())
            }}
          >
            <input
              aria-label={`Name ${device.browserName}`}
              value={drafts[device.id] ?? device.name}
              onChange={(event) => setDrafts((prev) => ({ ...prev, [device.id]: event.target.value }))}
              className="min-w-0 flex-1 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-base)] px-2 py-1 text-ui-xs"
            />
            <button type="submit" className="text-ui-xs text-[var(--accent-text)]">Save</button>
          </form>
        ))}
      </div>
    </section>
  )
}
