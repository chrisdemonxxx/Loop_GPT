'use client'

import { useEffect, useRef, useState } from 'react'
import { Monitor, RefreshCw } from 'lucide-react'
import { API_URL, mintNovncWsToken } from '@loop/api-client'

const MAX_RETRIES = 12
const NOVNC_SANDBOX_RE = /\/api\/bot\/novnc\/([A-Za-z0-9]+)\/websockify/

/**
 * Parse the backend's vendored noVNC HTML URL and extract the pieces we need
 * to connect natively: the websocket path, host override, VNC password, and
 * sandbox id (for minting a short-lived ws auth token).
 */
function parseVncUrl(url: string): {
  wsUrl: string
  password: string | null
  viewOnly: boolean
  missingPath: boolean
  sandboxId: string | null
} {
  const pageOrigin = typeof window !== 'undefined' ? window.location.origin : 'http://localhost'
  // Prefer the API origin when the app is split across hosts (NEXT_PUBLIC_API_URL).
  const apiOrigin = API_URL || pageOrigin
  const parsed = new URL(url, pageOrigin)
  const path = parsed.searchParams.get('path') || ''
  const password = parsed.searchParams.get('password')
  const viewOnly = parsed.searchParams.get('view_only') === 'true'
  const hostOverride = parsed.searchParams.get('host')
  const sandboxMatch = NOVNC_SANDBOX_RE.exec(path)
  const sandboxId = sandboxMatch?.[1] || null

  let wsHost: string
  let wsProtocol: string
  if (hostOverride) {
    // host= may be "hostname:port" or a full origin-like value.
    const hostUrl = hostOverride.includes('://')
      ? new URL(hostOverride)
      : new URL(`${apiOrigin.startsWith('https') ? 'https' : 'http'}://${hostOverride}`)
    wsHost = hostUrl.host
    wsProtocol = hostUrl.protocol === 'https:' ? 'wss:' : 'ws:'
  } else {
    const originUrl = new URL(apiOrigin, pageOrigin)
    wsHost = originUrl.host || parsed.host
    wsProtocol = originUrl.protocol === 'https:' ? 'wss:' : (parsed.protocol === 'https:' ? 'wss:' : 'ws:')
  }

  const missingPath = !path
  const wsUrl = path ? `${wsProtocol}//${wsHost}${path.startsWith('/') ? path : `/${path}`}` : ''

  return { wsUrl, password, viewOnly, missingPath, sandboxId }
}

/** Append the minted ws-token query param (`?token=` / `&token=`). */
function appendWsToken(wsUrl: string, token: string, queryParam = 'token'): string {
  const sep = wsUrl.includes('?') ? '&' : '?'
  return `${wsUrl}${sep}${encodeURIComponent(queryParam)}=${encodeURIComponent(token)}`
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
 * Mints a short-lived signed ws token before connect (desktop Bearer / proxy).
 */
export function BotScreen({ url, interactive = false }: BotScreenProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const rfbRef = useRef<any>(null)
  const [status, setStatus] = useState<'connecting' | 'connected' | 'disconnected' | 'error'>('connecting')
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const retryCountRef = useRef(0)
  const securityErrorRef = useRef<string | null>(null)

  useEffect(() => {
    let cancelled = false
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null

    async function connect() {
      if (!containerRef.current) return
      // The package's exports field only exposes the root specifier, and the
      // module touches `window` at import time — hence dynamic import inside
      // the effect (never during SSR) and never a deep subpath.
      const RFB = (await import('@novnc/novnc')).default
      if (cancelled) return

      let { wsUrl, password, viewOnly, missingPath, sandboxId } = parseVncUrl(url)
      if (missingPath || !wsUrl) {
        setStatus('error')
        setError('Stream URL is missing the websocket path — the computer may still be waking.')
        return
      }

      // Desktop / Bearer clients cannot send cookies on the WS upgrade — mint
      // a short-lived query token. Cookie sessions still work if mint fails.
      if (sandboxId) {
        try {
          const minted = await mintNovncWsToken(sandboxId)
          if (cancelled) return
          wsUrl = appendWsToken(wsUrl, minted.token, minted.queryParam || 'token')
        } catch {
          /* proceed without token — same-origin cookie auth may still pass */
        }
      }

      // Clean up any previous instance before making a new one.
      if (rfbRef.current) {
        try { rfbRef.current.disconnect() } catch { /* ignore */ }
        rfbRef.current = null
      }

      setStatus('connecting')
      // Preserve a prior securityfailure across reconnect attempts until a clean connect.
      if (!securityErrorRef.current) setError(null)

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
          securityErrorRef.current = null
          setError(null)
          setStatus('connected')
        }
        const onDisconnect = (ev: any) => {
          if (cancelled) return
          if (securityErrorRef.current) {
            setStatus('error')
            setError(securityErrorRef.current)
            return
          }
          setStatus('disconnected')
          if (!ev?.detail?.clean && retryCountRef.current < MAX_RETRIES) {
            reconnectTimer = setTimeout(() => {
              retryCountRef.current += 1
              setAttempt((n) => n + 1)
            }, 4000)
          } else if (!ev?.detail?.clean) {
            setStatus('error')
            setError('Lost connection to the computer after several retries.')
          }
        }
        const onCredentialsRequired = () => {
          if (password) rfb.sendCredentials({ password })
        }
        const onSecurityFailure = (ev: any) => {
          const reason = ev?.detail?.reason || 'Security failure'
          securityErrorRef.current = reason
          setStatus('error')
          setError(reason)
        }

        rfb.addEventListener('connect', onConnect)
        rfb.addEventListener('disconnect', onDisconnect)
        rfb.addEventListener('credentialsrequired', onCredentialsRequired)
        rfb.addEventListener('securityfailure', onSecurityFailure)
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
  const retriesExhausted = status === 'error' || (status === 'disconnected' && retryCountRef.current >= MAX_RETRIES)

  return (
    <div className="relative w-full h-full bg-black overflow-hidden">
      <div ref={containerRef} className="absolute inset-0 w-full h-full" />
      {showOverlay && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2.5 bg-[var(--bg-base)] text-center px-6">
          {retriesExhausted ? (
            <>
              <Monitor size={22} className="text-[var(--danger)]" aria-hidden />
              <p className="text-ui-sm text-[var(--danger)] max-w-sm">{error || securityErrorRef.current || 'Could not connect to the computer.'}</p>
              <button
                type="button"
                onClick={() => {
                  securityErrorRef.current = null
                  retryCountRef.current = 0
                  setError(null)
                  setAttempt((n) => n + 1)
                }}
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
