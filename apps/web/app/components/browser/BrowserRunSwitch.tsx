'use client'

import { useEffect, useId, useRef } from 'react'
import { deviceLabel, lastBrowserDeviceId, rememberBrowserDevice, useBrowserDevices, type BrowserDevice } from './useBrowserDevices'

/**
 * Section switch plus the online-device picker. Default is off.
 * The switch stays disabled until at least one browser is paired.
 */
export function BrowserRunSwitch({
  enabled,
  deviceId,
  onEnabled,
  onDevice,
  disabled,
  compact,
}: {
  enabled: boolean
  deviceId: string
  onEnabled: (next: boolean) => void
  onDevice: (id: string) => void
  disabled?: boolean
  compact?: boolean
}) {
  const selectId = useId()
  const { devices, ready } = useBrowserDevices()
  const paired = devices.length > 0
  const online = devices.filter((device) => device.online)
  const picked = useRef(false)

  useEffect(() => {
    if (picked.current || deviceId || !online.length) return
    picked.current = true
    const remembered = lastBrowserDeviceId()
    const pick = online.find((device) => device.id === remembered) || online[0]
    onDevice(pick.id)
  }, [deviceId, online, onDevice])

  return (
    <div className={`inline-flex items-center gap-2 ${compact ? '' : 'min-w-0'}`}>
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        aria-label="Paired browser"
        disabled={disabled || !ready || !paired}
        title={paired ? 'Use a paired browser for this run' : 'Pair a browser in Settings → Connectors'}
        onClick={() => {
          const next = !enabled
          if (next && deviceId) rememberBrowserDevice(deviceId)
          onEnabled(next)
        }}
        className={`relative h-5 w-9 shrink-0 rounded-full border transition ${
          enabled ? 'border-[var(--accent-soft-border)] bg-[var(--accent-soft)]' : 'border-white/10 bg-white/5'
        } disabled:opacity-40`}
      >
        <span className={`absolute top-0.5 h-3.5 w-3.5 rounded-full bg-white transition ${enabled ? 'left-4' : 'left-0.5'}`} />
      </button>
      <label className="sr-only" htmlFor={selectId}>Browser device</label>
      <select
        id={selectId}
        aria-label="Browser device"
        disabled={disabled || !paired}
        value={deviceId}
        onChange={(event) => {
          onDevice(event.target.value)
          rememberBrowserDevice(event.target.value)
        }}
        className="max-w-[14rem] truncate rounded-lg border border-white/10 bg-transparent px-2 py-1 text-[12px] text-slate-300 disabled:opacity-40"
      >
        {!paired && <option value="">Pair a browser in Connectors</option>}
        {paired && online.length === 0 && <option value="">No browser online</option>}
        {online.map((device: BrowserDevice) => (
          <option key={device.id} value={device.id}>{deviceLabel(device)}</option>
        ))}
      </select>
    </div>
  )
}
