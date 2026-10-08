'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, Copy, Download, X } from 'lucide-react'
import type { CanvasDoc } from '../../lib/canvasDoc'

/** Separate-origin preview host. When set, model HTML is loaded there so a
 *  script cannot read the app's token even if the sandbox is widened later.
 *  Empty means srcdoc inside sandbox="allow-scripts" (opaque origin). */
const ARTIFACT_ORIGIN = (process.env.NEXT_PUBLIC_ARTIFACT_ORIGIN || '').replace(/\/$/, '')

/** Claude-style code canvas. Preview re-renders a sandboxed iframe as the
 *  document streams (debounced). Chat keeps its own compact artifact card.
 *  Model HTML never opens in a blob: tab — that origin can read the parent. */
export function CanvasPanel({ doc, onClose }: { doc: CanvasDoc; onClose: () => void }) {
  const [tab, setTab] = useState<'code' | 'preview'>(doc.html ? 'preview' : 'code')
  const [copied, setCopied] = useState(false)
  const [width, setWidth] = useState(440)
  const [preview, setPreview] = useState(doc.content)

  useEffect(() => { setTab(doc.html ? 'preview' : 'code') }, [doc.filename, doc.html])
  useEffect(() => {
    const t = setTimeout(() => setPreview(doc.content), 180)
    return () => clearTimeout(t)
  }, [doc.content])

  const lines = useMemo(() => doc.content.split('\n'), [doc.content])

  const copy = () => {
    navigator.clipboard?.writeText(doc.content).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    }).catch(() => {})
  }
  const download = () => {
    const blob = new Blob([doc.content], { type: doc.html ? 'text/html' : 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = doc.filename
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <aside
      aria-label="Canvas"
      className="relative h-full shrink-0 flex flex-col bg-[var(--bg-sunken)] border-l border-white/[0.06] min-w-0 max-md:fixed max-md:inset-0 max-md:z-50 max-md:!w-full max-md:border-l-0"
      style={{ width }}
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize canvas"
        className="absolute left-0 top-0 bottom-0 w-1.5 cursor-col-resize max-md:hidden"
        onPointerDown={(e) => {
          const startX = e.clientX
          const startW = width
          const move = (ev: PointerEvent) => setWidth(Math.min(840, Math.max(320, startW - (ev.clientX - startX))))
          const up = () => {
            window.removeEventListener('pointermove', move)
            window.removeEventListener('pointerup', up)
          }
          window.addEventListener('pointermove', move)
          window.addEventListener('pointerup', up)
        }}
      />
      <div className="flex items-center gap-2 px-3 h-12 border-b border-white/[0.06] shrink-0 pt-[env(safe-area-inset-top)] md:pt-0">
        <span className="text-[13px] text-slate-200 truncate min-w-0 flex-1">{doc.title}</span>
        <div className="flex rounded-lg border border-white/[0.08] overflow-hidden text-[12px]">
          <button type="button" onClick={() => setTab('code')} className={`px-2.5 py-1 ${tab === 'code' ? 'bg-white/[0.08] text-slate-100' : 'text-slate-400'}`} aria-pressed={tab === 'code'}>Code</button>
          <button type="button" onClick={() => setTab('preview')} className={`px-2.5 py-1 ${tab === 'preview' ? 'bg-white/[0.08] text-slate-100' : 'text-slate-400'}`} aria-pressed={tab === 'preview'} disabled={!doc.html}>Preview</button>
        </div>
        <button type="button" onClick={copy} aria-label="Copy canvas" className="p-1.5 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-white/[0.05]">{copied ? <Check size={14} /> : <Copy size={14} />}</button>
        <button type="button" onClick={download} aria-label="Download canvas" title="Download to deploy" className="p-1.5 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-white/[0.05]"><Download size={14} /></button>
        <button type="button" onClick={onClose} aria-label="Close canvas" className="p-1.5 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-white/[0.05]"><X size={14} /></button>
      </div>
      {tab === 'preview' && doc.html ? (
        <SandboxedPreview html={preview} />
      ) : (
        <div className="flex-1 overflow-auto min-h-0 font-mono text-[12px] leading-5">
          <table className="w-full border-collapse">
            <tbody>
              {lines.map((line, i) => (
                <tr key={i}>
                  <td className="select-none text-right pr-3 pl-3 text-slate-600 w-10 align-top">{i + 1}</td>
                  <td className="text-slate-200 whitespace-pre pr-4">{line || ' '}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </aside>
  )
}

/** Model HTML runs only inside sandbox="allow-scripts" (no allow-same-origin).
 *  With NEXT_PUBLIC_ARTIFACT_ORIGIN, the frame's src is that host and the
 *  HTML is delivered by postMessage. Otherwise srcdoc gives the frame an
 *  opaque origin that cannot read the app. */
function SandboxedPreview({ html }: { html: string }) {
  const frameRef = useRef<HTMLIFrameElement>(null)
  useEffect(() => {
    if (!ARTIFACT_ORIGIN) return
    frameRef.current?.contentWindow?.postMessage({ type: 'loop-artifact-html', html }, ARTIFACT_ORIGIN)
  }, [html])
  if (ARTIFACT_ORIGIN) {
    return (
      <iframe
        ref={frameRef}
        title="Live preview"
        sandbox="allow-scripts"
        src={ARTIFACT_ORIGIN}
        onLoad={() => {
          frameRef.current?.contentWindow?.postMessage({ type: 'loop-artifact-html', html }, ARTIFACT_ORIGIN)
        }}
        className="flex-1 w-full bg-white min-h-0"
      />
    )
  }
  return (
    <iframe
      title="Live preview"
      sandbox="allow-scripts"
      srcDoc={html}
      className="flex-1 w-full bg-white min-h-0"
    />
  )
}
