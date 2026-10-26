'use client'

import { useEffect, useRef, useState } from 'react'
import { Ghost, Monitor, RefreshCw } from 'lucide-react'
import { API_URL, mintNovncWsToken, type BotTeachStep } from '@loop/api-client'

const MAX_RETRIES = 12
const NOVNC_SANDBOX_RE = /\/api\/bot\/novnc\/([A-Za-z0-9]+)\/websockify/
/** Remote desktop size. Teach steps are reported in this space, not CSS pixels. */
const FB_W = 1366
const FB_H = 768
const TYPE_FLUSH_MS = 400

type TeachInput = Omit<BotTeachStep, 'at'>

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
export function appendWsToken(wsUrl: string, token: string, queryParam = 'token'): string {
  try {
    const parsed = new URL(wsUrl)
    parsed.searchParams.set(queryParam, token)
    return parsed.toString()
  } catch {
    const sep = wsUrl.includes('?') ? '&' : '?'
    return `${wsUrl}${sep}${encodeURIComponent(queryParam)}=${encodeURIComponent(token)}`
  }
}

/** Map a CSS click on the scaled canvas back onto the 1366×768 framebuffer. */
function cssToFramebuffer(clientX: number, clientY: number, root: HTMLElement): { x: number; y: number } | null {
  const canvas = root.querySelector('canvas')
  const rect = (canvas ?? root).getBoundingClientRect()
  if (rect.width < 2 || rect.height < 2) return null
  const x = Math.round(((clientX - rect.left) / rect.width) * FB_W)
  const y = Math.round(((clientY - rect.top) / rect.height) * FB_H)
  return {
    x: Math.min(FB_W - 1, Math.max(0, x)),
    y: Math.min(FB_H - 1, Math.max(0, y)),
  }
}

/** Scale the framebuffer into the container. Never ask the VM to change resolution. */
function applyFramebufferFit(rfb: {
  scaleViewport: boolean
  resizeSession: boolean
  clampViewport?: boolean
  clipViewport?: boolean
}) {
  rfb.resizeSession = false
  rfb.scaleViewport = true
  // The plan calls this clampViewport. noVNC 1.7's setter is clipViewport.
  if ('clampViewport' in rfb) rfb.clampViewport = true
  if ('clipViewport' in rfb) rfb.clipViewport = true
}

interface BotScreenProps {
  /** The vendored /novnc/vnc.html?... URL returned by the backend. */
  url: string
  /** If true, allow keyboard/mouse input. Defaults false (view-only). */
  interactive?: boolean
  /**
   * While a teach recording is interactive, each click, special key, and
   * typed run is reported here. Coordinates are framebuffer pixels.
   */
  onOperatorInput?: (input: TeachInput) => void
}

/**
 * Native noVNC (RFB) client for the bot computer.
 *
 * The stream is scaled into the stage (`scaleViewport`) and the remote
 * session stays 1366×768 (`resizeSession: false`). A ResizeObserver
 * re-applies that scale when the stage grows (expand / layout).
 */
export function BotScreen({ url, interactive = false, onOperatorInput }: BotScreenProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const rfbRef = useRef<any>(null)
  const [status, setStatus] = useState<'connecting' | 'connected' | 'disconnected' | 'error'>('connecting')
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [cleanClose, setCleanClose] = useState(false)
  const retryCountRef = useRef(0)
  const securityErrorRef = useRef<string | null>(null)
  const onInputRef = useRef(onOperatorInput)
  onInputRef.current = onOperatorInput

  useEffect(() => {
    let cancelled = false
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null
    let resizeObserver: ResizeObserver | null = null

    async function connect() {
      const container = containerRef.current
      if (!container) return
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
        const rfb = new RFB(container, wsUrl, {
          shared: true,
          viewOnly: viewOnly || !interactive,
          resizeSession: false,
          scaleViewport: true,
          clampViewport: true,
        })
        // Constructor options for scale/resize are ignored by noVNC 1.7 — set the live properties.
        applyFramebufferFit(rfb)
        rfb.viewOnly = viewOnly || !interactive
        rfbRef.current = rfb

        const refreshScale = () => {
          if (rfbRef.current) applyFramebufferFit(rfbRef.current)
        }
        resizeObserver?.disconnect()
        resizeObserver = new ResizeObserver(() => { refreshScale() })
        resizeObserver.observe(container)

        const onConnect = () => {
          retryCountRef.current = 0
          securityErrorRef.current = null
          setError(null)
          setStatus('connected')
          refreshScale()
        }
        const onDisconnect = (ev: any) => {
          if (cancelled) return
          if (securityErrorRef.current) {
            setStatus('error')
            setError(securityErrorRef.current)
            return
          }
          // A clean close is the operator or the VM hanging up. Retrying it
          // looks like an endless wake. Offer Reconnect instead.
          if (ev?.detail?.clean) {
            setCleanClose(true)
            setStatus('disconnected')
            setError('Disconnected from the computer.')
            return
          }
          setCleanClose(false)
          setStatus('disconnected')
          if (retryCountRef.current < MAX_RETRIES) {
            reconnectTimer = setTimeout(() => {
              retryCountRef.current += 1
              setAttempt((n) => n + 1)
            }, 4000)
          } else {
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
      resizeObserver?.disconnect()
      if (reconnectTimer) clearTimeout(reconnectTimer)
      if (rfbRef.current) {
        try { rfbRef.current.disconnect() } catch { /* ignore */ }
        rfbRef.current = null
      }
    }
  }, [url, interactive, attempt])

  // Teach log: clicks, special keys, and coalesced typed runs. View-only watches do not record.
  useEffect(() => {
    if (!interactive || !onOperatorInput) return
    const root = containerRef.current
    if (!root) return
    let buf = ''
    let timer: ReturnType<typeof setTimeout> | null = null

    const flush = () => {
      if (timer) { clearTimeout(timer); timer = null }
      const text = buf
      buf = ''
      if (text) onInputRef.current?.({ kind: 'type', text })
    }

    const onClick = (ev: MouseEvent) => {
      if (ev.button !== 0) return
      const target = ev.target as HTMLElement | null
      if (target?.closest('button, a, input, textarea')) return
      flush()
      const pos = cssToFramebuffer(ev.clientX, ev.clientY, root)
      if (!pos) return
      onInputRef.current?.({ kind: 'click', x: pos.x, y: pos.y })
    }

    const onKey = (ev: KeyboardEvent) => {
      if (!root.contains(ev.target as Node)) return
      const printable = ev.key.length === 1 && !ev.ctrlKey && !ev.metaKey && !ev.altKey
      if (printable) {
        buf += ev.key
        if (timer) clearTimeout(timer)
        timer = setTimeout(flush, TYPE_FLUSH_MS)
        return
      }
      if (ev.repeat) return
      if (ev.key === 'Shift' || ev.key === 'Control' || ev.key === 'Alt' || ev.key === 'Meta') return
      flush()
      onInputRef.current?.({ kind: 'key', key: ev.key })
    }

    // Flush a typed run before Stop/click handlers run, while the session is still recording.
    const onPointerDown = () => { flush() }
    root.addEventListener('click', onClick)
    document.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => {
      root.removeEventListener('click', onClick)
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onPointerDown, true)
      flush()
    }
  }, [interactive, onOperatorInput])

  const showOverlay = status !== 'connected'
  const showReconnect = status === 'error' || (status === 'disconnected' && cleanClose)

  return (
    <div className="relative w-full h-full bg-black overflow-hidden">
      <div ref={containerRef} className="absolute inset-0 w-full h-full" />
      {showOverlay && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2.5 bg-black text-center px-6">
          {showReconnect ? (
            <>
              <Monitor size={22} className="text-[var(--danger)]" aria-hidden />
              <p className="text-ui-sm text-[var(--danger)] max-w-sm">{error || securityErrorRef.current || 'Could not connect to the computer.'}</p>
              <button
                type="button"
                onClick={() => {
                  securityErrorRef.current = null
                  retryCountRef.current = 0
                  setCleanClose(false)
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
              <Ghost size={28} className="text-white/80" aria-hidden />
              <p className="text-ui-sm text-white/80">Waking up…</p>
            </>
          )}
        </div>
      )}
    </div>
  )
}
