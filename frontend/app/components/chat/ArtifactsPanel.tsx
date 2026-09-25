'use client'

import { useState, useEffect, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { FileDown, Image as ImageIcon, Code, FileText, File, ChevronDown, DownloadIcon, Share2, Copy, GitCompare, X } from 'lucide-react'
import { API_URL, authHeaders } from '../../lib/api'
import type { ArtifactRef } from '../../lib/stream'
import Markdown from './Markdown'

interface Props {
  artifacts: ArtifactRef[]
  onClose: () => void
}

/** Group artifacts by base filename (stripping version suffixes). */
function groupVersions(artifacts: ArtifactRef[]): { base: string; versions: ArtifactRef[] }[] {
  const groups = new Map<string, ArtifactRef[]>()
  for (const a of artifacts) {
    const base = a.name.replace(/[_.-]\d+(\.\d+)*(?=\.[^.]*$)/, '').replace(/[_.-]v\d+/i, '')
    if (!groups.has(base)) groups.set(base, [])
    groups.get(base)!.push(a)
  }
  return [...groups.entries()].map(([base, versions]) => ({ base, versions: versions.sort((a, b) => a.id.localeCompare(b.id)) }))
}

type Tab = 'preview' | 'raw' | 'sandbox'

export default function ArtifactsPanel({ artifacts, onClose }: Props) {
  const groups = groupVersions(artifacts)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('preview')
  const [textContent, setTextContent] = useState<string | null>(null)
  const [published, setPublished] = useState<Record<string, string>>({})
  const [diff, setDiff] = useState<{ from: string; to: string; lines: { sign: string; text: string }[] } | null>(null)

  const selected = expanded ? artifacts.find((a) => a.id === expanded) : null

  // Fetch text content for code/markdown artifacts when selected.
  useEffect(() => {
    if (!selected) { setTextContent(null); return }
    const href = selected.url ? (selected.url.startsWith('http') ? selected.url : `${API_URL}${selected.url}`) : undefined
    if (!href || selected.kind === 'image') { setTextContent(null); return }
    let cancelled = false
    fetch(href, { headers: authHeaders(false) })
      .then((r) => r.text())
      .then((text) => { if (!cancelled) setTextContent(text) })
      .catch(() => { if (!cancelled) setTextContent(null) })
    return () => { cancelled = true }
  }, [selected])

  async function download(a: ArtifactRef) {
    const href = a.url ? (a.url.startsWith('http') ? a.url : `${API_URL}${a.url}`) : undefined
    if (!href) return
    try {
      const res = await fetch(href, { headers: authHeaders(false) })
      if (!res.ok) return
      const blob = await res.blob()
      const objectUrl = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = objectUrl; link.download = a.name; link.click(); link.remove()
      URL.revokeObjectURL(objectUrl)
    } catch { /* ignore */ }
  }

  async function togglePublish(a: ArtifactRef) {
    const href = a.url ? (a.url.startsWith('http') ? a.url : `${API_URL}${a.url}`) : ''
    const idMatch = href.match(/\/api\/files\/([^/]+)\//)
    if (!idMatch) return
    const id = idMatch[1]
    if (published[a.id]) {
      await fetch(`${API_URL}/api/files/${id}/publish`, { method: 'DELETE', headers: authHeaders() })
      setPublished((p) => { const n = { ...p }; delete n[a.id]; return n })
      return
    }
    const res = await fetch(`${API_URL}/api/files/${id}/publish`, { method: 'POST', headers: authHeaders() })
    if (!res.ok) return
    const { url } = await res.json()
    setPublished((p) => ({ ...p, [a.id]: `${API_URL}${url}` }))
  }

  async function compareVersions(g: { base: string; versions: ArtifactRef[] }) {
    const [older, newer] = [g.versions[0], g.versions[g.versions.length - 1]]
    const read = async (a: ArtifactRef) => {
      const href = a.url ? (a.url.startsWith('http') ? a.url : `${API_URL}${a.url}`) : ''
      const res = await fetch(href, { headers: authHeaders(false) })
      return res.ok ? (await res.text()).split('\n') : []
    }
    const [fromLines, toLines] = await Promise.all([read(older), read(newer)])
    setDiff({ from: older.name, to: newer.name, lines: lineDiff(fromLines, toLines) })
  }

  return (
    <motion.aside
      initial={{ x: 400, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      exit={{ x: 400, opacity: 0 }}
      transition={{ type: 'spring', stiffness: 320, damping: 34 }}
      className="fixed lg:relative inset-y-0 right-0 z-40 lg:z-auto flex w-full max-w-[92vw] sm:max-w-[440px] lg:w-[380px] lg:max-w-none shrink-0 px-2.5 sm:px-3 lg:p-3 h-full pt-[max(0.625rem,env(safe-area-inset-top))] pb-[max(0.625rem,env(safe-area-inset-bottom))] lg:pt-3 lg:pb-3"
    >
      <div className="glass-strong rounded-2xl h-full flex flex-col overflow-hidden shadow-panel">
        {/* Header */}
        <div className="flex items-center gap-2.5 px-4 py-3 border-b border-white/5">
          <div className="w-2 h-2 rounded-full bg-neon-fuchsia" />
          <div className="flex-1">
            <div className="text-sm font-semibold text-slate-100">Artifacts</div>
            <div className="text-[11px] text-slate-500">{artifacts.length} items</div>
          </div>
          {onClose && (
            <button onClick={onClose} className="p-1 -mr-1 rounded-lg hover:bg-white/5 text-slate-400" title="Close"><ChevronDown size={16} /></button>
          )}
        </div>

        {/* Version diff */}
        {diff && (
          <div className="border-b border-white/5 bg-black/20">
            <div className="flex items-center justify-between px-4 py-2">
              <div className="text-[11px] text-slate-400 truncate">{diff.from} → {diff.to}</div>
              <button onClick={() => setDiff(null)} className="text-slate-500 hover:text-slate-300"><X size={13} /></button>
            </div>
            <div className="max-h-56 overflow-auto px-3 pb-2 font-mono text-[11px] leading-relaxed">
              {diff.lines.map((l, i) => (
                <div key={i} className={l.sign === '+' ? 'text-emerald-400' : l.sign === '-' ? 'text-rose-400' : 'text-slate-500'}>
                  <span className="select-none">{l.sign} </span>{l.text || '\u00a0'}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Selected artifact detail */}
        <AnimatePresence>
          {selected && (
            <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }}
              className="border-b border-white/5 overflow-hidden">
              <div className="p-3 space-y-3">
                {/* Tab bar */}
                <div className="flex gap-1 text-[11px]">
                  {['preview', 'raw', 'sandbox'].filter((t) => t !== 'sandbox' || selected.kind === 'file').map((t) => (
                    <button key={t} onClick={() => setTab(t as Tab)}
                      className={`px-2.5 py-1 rounded-lg transition ${tab === t ? 'bg-white/10 text-slate-200' : 'text-slate-500 hover:text-slate-300'}`}>
                      {t === 'preview' ? 'Preview' : t === 'raw' ? 'Raw' : 'Sandbox'}
                    </button>
                  ))}
                </div>

                {/* Content */}
                <div className="max-h-[300px] overflow-auto">
                  {tab === 'preview' && selected.kind === 'image' && (
                    <img src={selected.url?.startsWith('http') ? selected.url : `${API_URL}${selected.url}`}
                      alt={selected.name} className="w-full rounded-xl border border-white/10" />
                  )}
                  {tab === 'preview' && textContent !== null && /\.(md|txt)$/i.test(selected.name) && (
                    <div className="text-[13px] leading-relaxed text-slate-200"><Markdown content={textContent.slice(0, 20000)} /></div>
                  )}
                  {tab === 'preview' && textContent !== null && !/\.(md|txt)$/i.test(selected.name) && (
                    <pre className="text-[12px] leading-relaxed text-slate-300 whitespace-pre-wrap font-mono">{textContent.slice(0, 20000)}</pre>
                  )}
                  {tab === 'raw' && textContent !== null && (
                    <pre className="text-[12px] leading-relaxed text-slate-400 whitespace-pre-wrap font-mono">{textContent.slice(0, 30000)}</pre>
                  )}
                  {(tab === 'sandbox' && selected.kind === 'file') && (
                    textContent !== null ? (
                      <iframe
                        title={selected.name}
                        srcDoc={textContent}
                        // No allow-same-origin: the document runs in an opaque
                        // origin and cannot touch the parent app or its storage.
                        sandbox="allow-scripts allow-popups"
                        className="w-full h-[280px] rounded-xl border border-white/10 bg-white"
                      />
                    ) : (
                      <div className="p-4 text-center text-[12px] text-slate-500">Loading preview…</div>
                    )
                  )}
                  {(tab !== 'preview' && textContent === null) && (
                    <div className="p-4 text-center text-[12px] text-slate-500">Loading content…</div>
                  )}
                </div>

                {/* Download / Publish */}
                <button onClick={() => download(selected)}
                  className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-xl glass hover:bg-white/5 text-[12px] text-slate-200 transition">
                  <DownloadIcon size={13} /> Download {selected.name}
                </button>
                <button onClick={() => togglePublish(selected)}
                  className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-xl glass hover:bg-white/5 text-[12px] text-slate-200 transition">
                  <Share2 size={13} /> {published[selected.id] ? 'Unpublish' : 'Publish view-only link'}
                </button>
                {published[selected.id] && (
                  <div className="text-[11px] text-slate-400 break-all flex items-center gap-1.5">
                    <a href={published[selected.id]} target="_blank" rel="noreferrer" className="text-sky-400 hover:underline">{published[selected.id]}</a>
                    <button onClick={() => navigator.clipboard?.writeText(published[selected.id])} className="text-slate-500 hover:text-slate-300" title="Copy"><Copy size={11} /></button>
                  </div>
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Artifact list */}
        <div className="flex-1 overflow-y-auto p-3 space-y-1.5">
          {groups.length === 0 && (
            <div className="h-full flex flex-col items-center justify-center text-center text-slate-600 gap-2">
              <FileText size={28} className="text-slate-700" />
              <p className="text-xs max-w-[200px]">Generated files and code snippets appear here as the agent creates them.</p>
            </div>
          )}
          {groups.map((g) => {
            const latest = g.versions[g.versions.length - 1]
            const isExpanded = expanded === latest.id
            return (
              <div key={g.base} className="glass rounded-xl overflow-hidden">
                <button
                  onClick={() => setExpanded(isExpanded ? null : latest.id)}
                  className="w-full flex items-center gap-2.5 px-3 py-2.5 text-left hover:bg-white/[0.03] transition"
                >
                  <IconForKind latest={latest} />
                  <span className="flex-1 min-w-0">
                    <span className="block text-[13px] text-slate-200 truncate">{g.base}</span>
                    {g.versions.length > 1 && (
                      <span className="text-[10px] text-slate-500">{g.versions.length} versions</span>
                    )}
                  </span>
                  <span className="text-[10px] uppercase tracking-wide text-slate-500">{latest.kind}</span>
                </button>
                {isExpanded && g.versions.length > 1 && (
                  <div className="border-t border-white/5 px-3 py-1.5 space-y-1">
                    <button onClick={() => compareVersions(g)}
                      className="flex items-center gap-1.5 w-full text-left text-[11px] text-neon-violet hover:underline pb-1">
                      <GitCompare size={11} /> Compare {g.versions.length} versions
                    </button>
                    {g.versions.map((v) => (
                      <button key={v.id} onClick={() => download(v)}
                        className="flex items-center gap-2 w-full text-left text-[11px] text-slate-400 hover:text-slate-200 transition py-0.5">
                        <span className="font-mono">v{String(g.versions.indexOf(v) + 1)}</span>
                        <span className="truncate">{v.name}</span>
                        <DownloadIcon size={10} className="ml-auto shrink-0" />
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </motion.aside>
  )
}

/** Minimal line diff: unchanged lines prefixed ' ', removed '-', added '+'. */
function lineDiff(from: string[], to: string[]): { sign: string; text: string }[] {
  const out: { sign: string; text: string }[] = []
  const max = Math.max(from.length, to.length)
  for (let i = 0; i < max && out.length < 800; i++) {
    const a = from[i]
    const b = to[i]
    if (a === b) { if (a !== undefined) out.push({ sign: ' ', text: a }); continue }
    if (a !== undefined) out.push({ sign: '-', text: a })
    if (b !== undefined) out.push({ sign: '+', text: b })
  }
  return out
}

function IconForKind({ latest }: { latest: ArtifactRef }) {
  if (latest.kind === 'image') return <ImageIcon size={16} className="text-neon-cyan shrink-0" />
  if (/\.(md|txt)$/i.test(latest.name)) return <FileText size={16} className="text-neon-violet shrink-0" />
  if (/\.(js|ts|jsx|tsx|py|go|rs|rb)$/i.test(latest.name)) return <Code size={16} className="text-neon-green shrink-0" />
  return <File size={16} className="text-slate-500 shrink-0" />
}
