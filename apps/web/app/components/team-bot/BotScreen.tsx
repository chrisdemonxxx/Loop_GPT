'use client'

import { useEffect, useRef, useState } from 'react'
import { Monitor, RefreshCw } from 'lucide-react'

/**
 * Parse the backend's vendored noVNC HTML URL and extract the pieces we need
 * to connect natively: the websocket path and the VNC password.
 */
function parseVncUrl(url: string): { wsUrl: string; password: string | null; viewOnly: boolean } {
  const parsed = new URL(url, typeof window !== 'undefined' ? window.location.href : 'http://localhost')
  const path = parsed.searchParams.get('path') || ''
  const password = parsed.searchParams.get('password')
  const viewOnly = parsed.searchParams.get('view_only') === 'true'

  const protocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:'
  const wsUrl = path ? `${protocol}//${parsed.host}${path}` : url

  return { wsUrl, password, viewOnly }
}

interface BotScreenProps {
  /** The vendored /novnc/vnc.html?... URL returned by the backend. */
  url: string
  /** If true, allow keyboard/mouse input. Defaults false (view-only). */
  interactive?: boolean
}

/**
 * Native noVNC (RFB) client for the bot computer.
 *
 * Replaces the iframe-based StreamFrame with a same-origin RFB connection so
 * the stream lives inside the React tree and can be resized, reconnect, and
 * swap between view-only and interactive modes without iframe reload races.
 */
export function BotScreen({ url, interactive = false }: BotScreenProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const rfbRef = useRef<any>(null)
  const [status, setStatus] = useState<'connecting' | 'connected' | 'disconnected' | 'error'>('connecting')
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const retryCountRef = useRef(0)

  useEffect(() => {
    let cancelled = false
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null

    async function connect() {
      if (!containerRef.current) return
      const RFB = (await import('@novnc/novnc/core/rfb')).default
      if (cancelled) return

      const { wsUrl, password, viewOnly } = parseVncUrl(url)

      // Clean up any previous instance before making a new one.
      if (rfbRef.current) {
        try { rfbRef.current.disconnect() } catch { /* ignore */ }
        rfbRef.current = null
      }

      setStatus('connecting')
      setError(null)

      try {
        const rfb = new RFB(containerRef.current, wsUrl, {
          shared: true,
          viewOnly: viewOnly || !interactive,
          resizeSession: true,
          scaleViewport: true,
          clampViewport: false,
        })
        rfbRef.current = rfb

        const onConnect = () => {
          retryCountRef.current = 0
          setStatus('connected')
        }
        const onDisconnect = (ev: any) => {
          if (cancelled) return
          setStatus('disconnected')
          if (!ev?.detail?.clean && retryCountRef.current < 12) {
            reconnectTimer = setTimeout(() => {
              retryCountRef.current += 1
              setAttempt((n) => n + 1)
            }, 4000)
          }
        }
        const onCredentialsRequired = () => {
          if (password) rfb.sendCredentials({ password })
        }
        const onSecurityFailure = (ev: any) => {
          setStatus('error')
          setError(ev?.detail?.reason || 'Security failure')
        }
        const onDesktopName = (ev: any) => {
          // Surface name if useful for future overlays.
        }

        rfb.addEventListener('connect', onConnect)
        rfb.addEventListener('disconnect', onDisconnect)
        rfb.addEventListener('credentialsrequired', onCredentialsRequired)
        rfb.addEventListener('securityfailure', onSecurityFailure)
        rfb.addEventListener('desktopname', onDesktopName)
      } catch (err: any) {
        setStatus('error')
        setError(err?.message || 'Could not start VNC client')
      }
    }

    void connect()

    return () => {
      cancelled = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      if (rfbRef.current) {
        try { rfbRef.current.disconnect() } catch { /* ignore */ }
        rfbRef.current = null
      }
    }
  }, [url, interactive, attempt])

  const showOverlay = status !== 'connected'

  return (
    <div className="relative w-full h-full bg-black overflow-hidden">
      <div ref={containerRef} className="absolute inset-0 w-full h-full" />
      {showOverlay && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2.5 bg-[var(--bg-base)] text-center px-6">
          {status === 'error' ? (
            <>
              <Monitor size={22} className="text-[var(--danger)]" aria-hidden />
              <p className="text-ui-sm text-[var(--danger)] max-w-sm">{error || 'Could not connect to the computer.'}</p>
              <button
                type="button"
                onClick={() => { retryCountRef.current = 0; setAttempt((n) => n + 1) }}
                className="mt-1 flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-ui-xs text-white bg-[var(--accent-fill)] hover:bg-[var(--accent-fill-hover)] transition"
              >
                <RefreshCw size={12} aria-hidden /> Reconnect
              </button>
            </>
          ) : (
            <>
              <LoadingDots />
              <p className="text-ui-sm text-[var(--ink-secondary)]">
                {status === 'disconnected' ? 'Reconnecting to the computer…' : 'Connecting to the computer…'}
              </p>
              <p className="text-2xs text-[var(--ink-muted)]">Waking the stream; this takes a few seconds after a resume.</p>
            </>
          )}
        </div>
      )}
    </div>
  )
}

function LoadingDots() {
  return (
    <div className="flex items-center gap-1.5" aria-hidden>
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="w-2 h-2 rounded-full bg-[var(--ink-muted)] animate-bounce"
          style={{ animationDelay: `${i * 0.15}s`, animationDuration: '0.9s' }}
        />
      ))}
    </div>
  )
}
