'use client'

import { useEffect, useId, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { authHeaders } from '../../lib/api'
import type { ArtifactRef } from '../../lib/stream'
import { artifactHref, useAuthedUrl } from './artifactUrl'

/** In-panel PDF viewer: the browser's native PDF engine via a blob iframe. */
export function PdfView({ a }: { a: ArtifactRef }) {
  const href = artifactHref(a.url)
  const blobUrl = useAuthedUrl(a.kind === 'pdf' ? href : undefined)
  if (!blobUrl) return <Loading label="Loading PDF…" />
  return (
    <iframe
      title={`PDF preview: ${a.name}`}
      src={`${blobUrl}#toolbar=1&view=FitH`}
      className="w-full h-full min-h-[320px] rounded-xl border border-white/10 bg-white"
    />
  )
}

/** In-panel spreadsheet viewer (xlsx/csv) — SheetJS, dynamically imported. */
export function SheetView({ a }: { a: ArtifactRef }) {
  const href = artifactHref(a.url)
  const [rows, setRows] = useState<string[][] | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (!href) return
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch(href, { headers: authHeaders(false) })
        if (!res.ok) throw new Error('fetch')
        const XLSX = await import('xlsx')
        const wb = XLSX.read(await res.arrayBuffer(), { type: 'array' })
        const sheet = wb.Sheets[wb.SheetNames[0]]
        const parsed = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, blankrows: false })
        if (!cancelled) setRows(parsed.map((r) => (r as unknown[]).map((c) => (c === undefined || c === null ? '' : String(c)))))
      } catch { if (!cancelled) setError('Could not read this spreadsheet.') }
    })()
    return () => { cancelled = true }
  }, [href])
  if (error) return <div className="p-4 text-center text-[12px] text-slate-500">{error}</div>
  if (!rows) return <Loading label="Loading spreadsheet…" />
  return (
    <div className="overflow-auto">
      <table className="w-full text-[12px] border-collapse">
        <tbody>
          {rows.slice(0, 500).map((row, i) => (
            <tr key={i} className={i === 0 ? 'bg-white/[0.05] font-medium' : 'odd:bg-white/[0.02]'}>
              {row.slice(0, 20).map((cell, j) => (
                <td key={j} className="border border-white/[0.06] px-2 py-1 whitespace-nowrap text-slate-300">{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > 500 && <div className="px-2 py-1.5 text-[11px] text-slate-500">Showing first 500 of {rows.length} rows.</div>}
    </div>
  )
}

/** Mermaid diagram renderer (dynamic import; .mmd artifacts + md fences). */
export function MermaidView({ code }: { code: string }) {
  const reactId = useId().replace(/[^a-zA-Z0-9]/g, '')
  const [svg, setSvg] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const renderSeq = useRef(0)
  useEffect(() => {
    let cancelled = false
    const seq = ++renderSeq.current
      ; (async () => {
        try {
          const mermaid = (await import('mermaid')).default
          mermaid.initialize({ startOnLoad: false, theme: 'dark', securityLevel: 'strict' })
          const { svg } = await mermaid.render(`mmd-${reactId}-${seq}`, code)
          if (!cancelled && seq === renderSeq.current) { setSvg(svg); setError(null) }
        } catch (e: any) {
          if (!cancelled && seq === renderSeq.current) setError(e?.message || 'Diagram failed to render')
        }
      })()
    return () => { cancelled = true }
  }, [code, reactId])
  if (error) return (
    <div className="rounded-xl border border-rose-500/20 bg-rose-500/[0.04] p-3 text-[12px] text-rose-300">
      Diagram error: {error}
    </div>
  )
  if (!svg) return <Loading label="Rendering diagram…" />
  return <div className="flex items-center justify-center p-2 overflow-auto" dangerouslySetInnerHTML={{ __html: svg }} />
}

/** Loading placeholder with spinner + label. */
export function Loading({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 justify-center py-10 text-[12px] text-slate-500">
      <Loader2 size={14} className="animate-spin" /> {label}
    </div>
  )
}

/** Build the sandboxed srcDoc for HTML artifacts with the error bridge that
 * reports uncaught errors (and rejections) back to the panel for the
 * "Fix error" affordance. */
export function withErrorBridge(html: string): string {
  const bridge = `<script>(function(){
    var send=function(m){try{parent.postMessage({__artifactError:String(m)},'*')}catch(e){}};
    window.addEventListener('error',function(e){send(e.message||'Script error')});
    window.addEventListener('unhandledrejection',function(e){send(e.reason||'Unhandled rejection')});
  })()</script>`
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head([^>]*)>/i, `<head$1>${bridge}`)
  return `${bridge}${html}`
}

export type ArtifactDevice = 'desktop' | 'tablet' | 'mobile'

/** Preview viewport widths for the device-size toggle. */
export const DEVICE_WIDTH: Record<ArtifactDevice, string> = {
  desktop: '100%',
  tablet: '768px',
  mobile: '390px',
}
