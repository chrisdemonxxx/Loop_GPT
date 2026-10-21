'use client'

/**
 * Phase 3.2 — interactive terminal.
 * Prefers sandbox PTY websocket when a lease + admin scope exist; otherwise
 * keeps the offline exec UX with per-project localStorage history.
 */

import { useEffect, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import {
  buildPtyWebSocketUrl,
  getLoopitToken,
  getPtyInfo,
  toUserFacingError,
} from '@loop/loopit-client'
import { useToast } from '../lib/toast'
import { useExecCommand } from './hooks'
import {
  loadTerminalHistory,
  saveTerminalHistory,
  type StoredTerminalEntry,
} from './fileTree'

export type TerminalEntry = StoredTerminalEntry

export function TerminalPane({
  projectId,
  history,
  onHistoryChange,
}: {
  projectId: string | null
  history: TerminalEntry[]
  onHistoryChange: React.Dispatch<React.SetStateAction<TerminalEntry[]>>
}) {
  const [mode, setMode] = useState<'pty' | 'exec' | 'loading'>('loading')
  const [ptyDetail, setPtyDetail] = useState<string | null>(null)

  useEffect(() => {
    if (!projectId) {
      setMode('exec')
      return
    }
    let cancelled = false
    void getPtyInfo(projectId)
      .then((info) => {
        if (cancelled) return
        setPtyDetail(info.detail ?? null)
        setMode(info.available ? 'pty' : 'exec')
      })
      .catch(() => {
        if (!cancelled) setMode('exec')
      })
    return () => { cancelled = true }
  }, [projectId])

  // Hydrate history from localStorage once per project.
  useEffect(() => {
    if (!projectId) return
    const stored = loadTerminalHistory(projectId)
    if (stored.length && history.length === 0) onHistoryChange(stored)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- hydrate once when project changes
  }, [projectId])

  useEffect(() => {
    if (!projectId || !history.length) return
    saveTerminalHistory(projectId, history)
  }, [projectId, history])

  if (mode === 'loading') {
    return (
      <div className="flex flex-1 items-center gap-2 p-3 text-2xs text-[var(--ink-muted)]">
        <Loader2 size={11} className="animate-spin" /> Checking terminal…
      </div>
    )
  }

  if (mode === 'pty' && projectId) {
    return <PtyTerminal projectId={projectId} detail={ptyDetail} onHistoryChange={onHistoryChange} />
  }

  return (
    <ExecTerminal
      projectId={projectId}
      history={history}
      onHistoryChange={onHistoryChange}
      detail={ptyDetail}
    />
  )
}

function ExecTerminal({
  projectId,
  history,
  onHistoryChange,
  detail,
}: {
  projectId: string | null
  history: TerminalEntry[]
  onHistoryChange: React.Dispatch<React.SetStateAction<TerminalEntry[]>>
  detail: string | null
}) {
  const exec = useExecCommand(projectId)
  const toast = useToast()
  const [command, setCommand] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [history.length, exec.isPending])

  const run = () => {
    const trimmed = command.trim()
    if (!trimmed || exec.isPending || !projectId) return
    setCommand('')
    exec.mutate({ command: trimmed, timeoutSeconds: 60 }, {
      onSuccess: (result) => onHistoryChange((prev) => [...prev, {
        id: `${Date.now()}`,
        command: result.command,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exit_code,
        duration: result.duration_seconds,
      }]),
      onError: (cause) => toast.push('error', toUserFacingError(cause).message),
    })
  }

  return (
    <div className="flex flex-1 min-h-0 flex-col">
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-auto bg-black p-3 font-mono text-2xs">
        {history.length === 0 && (
          <p className="text-[var(--ink-muted)]">
            Offline exec — commands run in the project workspace.
            {detail ? ` ${detail}` : ' History is saved per project.'}
          </p>
        )}
        {history.map((h) => (
          <div key={h.id} className="mb-3">
            <div className="flex items-center gap-2 text-[var(--accent-text)]">
              <span className="text-[var(--success)]">$</span>
              <span>{h.command}</span>
              <span className="ml-auto text-[var(--ink-muted)]">{h.duration.toFixed(2)}s</span>
            </div>
            {h.stdout && <pre className="mt-1 whitespace-pre-wrap text-[var(--ink-secondary)]">{h.stdout}</pre>}
            {h.stderr && <pre className="mt-1 whitespace-pre-wrap text-[var(--danger)]">{h.stderr}</pre>}
            <div className={`mt-1 text-3xs ${h.exitCode === 0 ? 'text-[var(--success)]' : 'text-[var(--danger)]'}`}>exit {h.exitCode}</div>
          </div>
        ))}
        {exec.isPending && <p className="text-[var(--ink-muted)] flex items-center gap-2"><Loader2 size={11} className="animate-spin" /> Running…</p>}
      </div>
      <div className="border-t border-[var(--border-subtle)] p-3 shrink-0 bg-[var(--bg-base)]">
        <div className="flex items-center gap-2">
          <span className="text-[var(--success)] font-mono text-ui-xs">$</span>
          <input
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') run() }}
            placeholder="Type a command and press Enter"
            disabled={exec.isPending}
            className="flex-1 bg-transparent text-ui-xs text-[var(--ink-primary)] placeholder:text-[var(--ink-muted)] focus:outline-none font-mono"
          />
          <button
            type="button"
            onClick={run}
            disabled={exec.isPending || !command.trim()}
            className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--accent-fill)] px-3 py-1.5 text-ui-xs font-medium text-white hover:bg-[var(--accent-fill-hover)] disabled:opacity-50 transition"
          >
            Run
          </button>
        </div>
      </div>
    </div>
  )
}

function PtyTerminal({
  projectId,
  detail,
  onHistoryChange,
}: {
  projectId: string
  detail: string | null
  onHistoryChange: React.Dispatch<React.SetStateAction<TerminalEntry[]>>
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const [status, setStatus] = useState<'connecting' | 'ready' | 'error'>('connecting')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let disposed = false
    let term: { write: (d: string) => void; dispose: () => void; onData: (cb: (d: string) => void) => { dispose: () => void }; focus: () => void } | null = null
    let fitAddon: { fit: () => void } | null = null
    let socket: WebSocket | null = null
    let lineBuffer = ''
    let dataDisposable: { dispose: () => void } | null = null

    const boot = async () => {
      try {
        const [{ Terminal }, { FitAddon }] = await Promise.all([
          import('@xterm/xterm'),
          import('@xterm/addon-fit'),
        ])
        try {
          await import('@xterm/xterm/css/xterm.css')
        } catch {
          /* CSS optional in offline/test shells */
        }

        if (disposed || !hostRef.current) return
        const terminal = new Terminal({
          convertEol: true,
          fontSize: 12,
          theme: { background: '#000000', foreground: '#d4d4d4' },
          cursorBlink: true,
        })
        const fit = new FitAddon()
        terminal.loadAddon(fit)
        terminal.open(hostRef.current)
        fit.fit()
        term = terminal
        fitAddon = fit

        const token = await getLoopitToken()
        const info = await getPtyInfo(projectId)
        const url = buildPtyWebSocketUrl(info.ws_path, token)
        socket = new WebSocket(url)

        socket.onopen = () => {
          if (disposed) return
          setStatus('ready')
          terminal.writeln(`\x1b[90m${detail || 'Connected — sandbox PTY preferred when leased.'}\x1b[0m`)
          terminal.write('$ ')
        }
        socket.onerror = () => {
          if (!disposed) {
            setStatus('error')
            setError('WebSocket failed — falling back is available by reopening Offline exec.')
          }
        }
        socket.onclose = () => {
          if (!disposed) setStatus('error')
        }
        socket.onmessage = (event) => {
          try {
            const msg = JSON.parse(String(event.data)) as { type?: string; data?: string; exit_code?: number; mode?: string }
            if (msg.type === 'ready') {
              terminal.writeln(`\x1b[90mmode=${msg.mode || 'unknown'}\x1b[0m`)
              return
            }
            if (msg.type === 'output') {
              terminal.write(msg.data || '')
              terminal.write('$ ')
              onHistoryChange((prev) => [...prev, {
                id: `${Date.now()}`,
                command: lineBuffer || '(pty)',
                stdout: msg.data || '',
                stderr: '',
                exitCode: msg.exit_code ?? 0,
                duration: 0,
              }])
              lineBuffer = ''
            }
            if (msg.type === 'exit') {
              terminal.writeln('\r\n[session ended]')
              socket?.close()
            }
          } catch {
            terminal.write(String(event.data))
          }
        }

        dataDisposable = terminal.onData((data) => {
          if (data === '\r') {
            terminal.write('\r\n')
            const command = lineBuffer
            lineBuffer = ''
            if (socket?.readyState === WebSocket.OPEN) {
              socket.send(JSON.stringify({ type: 'input', data: command }))
            }
            return
          }
          if (data === '\u007f') {
            if (lineBuffer.length) {
              lineBuffer = lineBuffer.slice(0, -1)
              terminal.write('\b \b')
            }
            return
          }
          if (data >= ' ' || data === '\t') {
            lineBuffer += data
            terminal.write(data)
          }
        })

        terminal.focus()
        const onResize = () => fitAddon?.fit()
        window.addEventListener('resize', onResize)
        return () => window.removeEventListener('resize', onResize)
      } catch (cause) {
        if (!disposed) {
          setStatus('error')
          setError(toUserFacingError(cause).message)
        }
      }
    }

    void boot()
    return () => {
      disposed = true
      dataDisposable?.dispose()
      socket?.close()
      term?.dispose()
    }
  }, [projectId, detail, onHistoryChange])

  return (
    <div className="flex flex-1 min-h-0 flex-col bg-black">
      {status === 'connecting' && (
        <p className="p-2 text-3xs text-[var(--ink-muted)] flex items-center gap-2">
          <Loader2 size={11} className="animate-spin" /> Connecting PTY…
        </p>
      )}
      {error && <p className="p-2 text-3xs text-[var(--danger)]">{error}</p>}
      <div ref={hostRef} className="flex-1 min-h-0 p-2" data-testid="xterm-host" />
    </div>
  )
}
