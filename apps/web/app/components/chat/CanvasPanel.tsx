'use client'

import { useEffect, useMemo, useState } from 'react'
import { Check, Copy, Download, ExternalLink, X } from 'lucide-react'
import type { CanvasDoc } from '../../lib/canvasDoc'

/** Claude-style code canvas. Preview re-renders a sandboxed iframe as the
 *  document streams (debounced). Chat keeps its own compact artifact card. */
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
  const openTab = () => {
    const blob = new Blob([doc.html ? doc.content : `<pre>${doc.content.replace(/</g, '&lt;')}</pre>`], { type: 'text/html' })
    const url = URL.createObjectURL(blob)
    window.open(url, '_blank', 'noopener')
    setTimeout(() => URL.revokeObjectURL(url), 30_000)
  }

  return (
    <aside
      aria-label="Canvas"
      className="relative h-full shrink-0 flex flex-col bg-[#0c0c0e] border-l border-white/[0.06] min-w-0"
      style={{ width }}
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize canvas"
        className="absolute left-0 top-0 bottom-0 w-1.5 cursor-col-resize"
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
      <div className="flex items-center gap-2 px-3 h-12 border-b border-white/[0.06] shrink-0">
        <span className="text-[13px] text-slate-200 truncate min-w-0 flex-1">{doc.title}</span>
        <div className="flex rounded-lg border border-white/[0.08] overflow-hidden text-[12px]">
          <button type="button" onClick={() => setTab('code')} className={`px-2.5 py-1 ${tab === 'code' ? 'bg-white/[0.08] text-slate-100' : 'text-slate-400'}`} aria-pressed={tab === 'code'}>Code</button>
          <button type="button" onClick={() => setTab('preview')} className={`px-2.5 py-1 ${tab === 'preview' ? 'bg-white/[0.08] text-slate-100' : 'text-slate-400'}`} aria-pressed={tab === 'preview'} disabled={!doc.html}>Preview</button>
        </div>
        <button type="button" onClick={copy} aria-label="Copy canvas" className="p-1.5 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-white/[0.05]">{copied ? <Check size={14} /> : <Copy size={14} />}</button>
        <button type="button" onClick={download} aria-label="Download canvas" title="Download to deploy" className="p-1.5 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-white/[0.05]"><Download size={14} /></button>
        <button type="button" onClick={openTab} aria-label="Open preview in a new tab" className="p-1.5 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-white/[0.05]"><ExternalLink size={14} /></button>
        <button type="button" onClick={onClose} aria-label="Close canvas" className="p-1.5 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-white/[0.05]"><X size={14} /></button>
      </div>
      {tab === 'preview' && doc.html ? (
        <iframe
          title="Live preview"
          sandbox="allow-scripts"
          srcDoc={preview}
          className="flex-1 w-full bg-white min-h-0"
        />
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
