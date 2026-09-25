'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  FileDown, Image as ImageIcon, Code, FileText, File, ChevronDown, ChevronLeft, DownloadIcon,
  Share2, Copy, GitCompare, X, Maximize2, Minimize2, RefreshCw, ExternalLink, Monitor, Tablet, Smartphone, Wrench,
} from 'lucide-react'
import { authHeaders } from '../../lib/api'
import type { ArtifactRef } from '../../lib/stream'
import Markdown from './Markdown'
import { artifactHref, artifactFileId, downloadArtifact, openArtifactInNewTab, useAuthedText, useAuthedUrl, isVideoArtifact } from './artifactUrl'
import { PdfView, SheetView, MermaidView, withErrorBridge, DEVICE_WIDTH, type ArtifactDevice } from './ArtifactViewers'
import VideoPlayer from './VideoPlayer'
import Lightbox from './Lightbox'

interface Props {
  artifacts: ArtifactRef[]
  onClose: () => void
  /** Focused artifact id (opened from an artifact card in the chat). */
  focusId?: string | null
  onBackToList?: () => void
  /** Focus an artifact from the panel's own list (focus stays page-owned). */
  onFocusArtifact?: (id: string) => void
  /** In-flight artifact-producing tools → "Building…" placeholders. */
  buildingKinds?: string[]
  /** Composer prefill for the sandbox "Fix error" affordance. */
  onFixError?: (prompt: string) => void
}

const WIDTH_KEY = 'artifactsPanelWidth'
const MIN_W = 320
const MAX_W = 720

/** lg+ viewport check so the persisted width only applies on desktop. */
function useIsDesktopViewport(): boolean {
  const [isDesktop, setIsDesktop] = useState(false)
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 1024px)')
    const apply = () => setIsDesktop(mq.matches)
    apply()
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [])
  return isDesktop
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

const BUILDING_LABEL: Record<string, string> = {
  create_document: 'Building document…',
  generate_image: 'Generating image…',
  generate_video: 'Generating video…',
  generate_style: 'Rendering style…',
}

export default function ArtifactsPanel({ artifacts, onClose, focusId, onBackToList, onFocusArtifact, buildingKinds = [], onFixError }: Props) {
  const groups = groupVersions(artifacts)
  const focused = focusId ? artifacts.find((a) => a.id === focusId) || null : null
  const isDesktopViewport = useIsDesktopViewport()

  // ── Panel chrome: persisted width + fullscreen ─────────────────────────
  const [width, setWidth] = useState(380)
  const [fullscreen, setFullscreen] = useState(false)
  useEffect(() => {
    const saved = Number(localStorage.getItem(WIDTH_KEY))
    if (Number.isFinite(saved) && saved >= MIN_W && saved <= MAX_W) setWidth(saved)
  }, [])
  const dragRef = useRef<{ startX: number; startW: number } | null>(null)
  const onDragStart = (e: React.PointerEvent) => {
    if (fullscreen) return
    dragRef.current = { startX: e.clientX, startW: width }
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
  }
  const onDragMove = (e: React.PointerEvent) => {
    if (!dragRef.current) return
    const next = Math.min(MAX_W, Math.max(MIN_W, dragRef.current.startW + (dragRef.current.startX - e.clientX)))
    setWidth(next)
  }
  const onDragEnd = () => {
    if (dragRef.current) { dragRef.current = null; localStorage.setItem(WIDTH_KEY, String(width)) }
  }

  // ── Focused view state ──────────────────────────────────────────────────
  const [tab, setTab] = useState<Tab>('preview')
  const [device, setDevice] = useState<ArtifactDevice>('desktop')
  const [nonce, setNonce] = useState(0)
  const [published, setPublished] = useState<Record<string, string>>({})
  const [sandboxError, setSandboxError] = useState<string | null>(null)
  const [diff, setDiff] = useState<{ from: string; to: string; lines: { sign: string; text: string }[] } | null>(null)
  const [lightboxOpen, setLightboxOpen] = useState(false)

  useEffect(() => { setTab('preview'); setSandboxError(null) }, [focusId])

  const isHtml = !!(focused && /\.(html?|htm)$/i.test(focused.name))
  const isSheet = !!(focused && (focused.kind === 'xlsx' || focused.kind === 'csv' || /\.(xlsx?|csv)$/i.test(focused.name)))
  const isPdf = focused?.kind === 'pdf' || /\.(pdf)$/i.test(focused?.name || '')
  const isMermaid = !!(focused && (/\.(mmd|mermaid)$/i.test(focused.name) || focused.kind === 'mermaid'))
  const { text: textContent, loading: textLoading } = useAuthedText(
    focused && focused.kind !== 'image' && !isVideoArtifact(focused) && !isPdf && !isSheet && !isMermaid ? artifactHref(focused.url) : undefined,
  )
  const mermaidText = useAuthedText(isMermaid ? artifactHref(focused?.url) : undefined)
  // Images need authed blob URLs — a raw <img src> would 401. Videos stream
  // via the signed-URL VideoPlayer instead.
  const focusHref = focused ? artifactHref(focused.url) : undefined
  const focusImage = useAuthedUrl(focused?.kind === 'image' ? focusHref : undefined)

  // Sandbox error bridge: uncaught errors inside the previewed document.
  useEffect(() => {
    if (!focused || tab !== 'sandbox') return
    const onMessage = (e: MessageEvent) => {
      if (e.data && typeof e.data.__artifactError === 'string') setSandboxError(e.data.__artifactError)
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [focused, tab])

  const fixPrompt = useCallback(() => {
    if (!focused || !sandboxError) return
    const source = (textContent || '').slice(0, 8000)
    onFixError?.(
      `Fix the error in the artifact "${focused.name}". The sandboxed preview threw:\n\n${sandboxError}\n\n` +
      (source ? `Current source:\n\n\`\`\`\n${source}\n\`\`\`\n\n` : '') +
      'Regenerate the corrected artifact.',
    )
  }, [focused, sandboxError, textContent, onFixError])

  async function togglePublish(a: ArtifactRef) {
    const id = artifactFileId(a)
    if (!id) return
    if (published[a.id]) {
      await fetch(`/api/files/${id}/publish`, { method: 'DELETE', headers: authHeaders() })
      setPublished((p) => { const n = { ...p }; delete n[a.id]; return n })
      return
    }
    const res = await fetch(`/api/files/${id}/publish`, { method: 'POST', headers: authHeaders() })
    if (!res.ok) return
    const { url } = await res.json()
    setPublished((p) => ({ ...p, [a.id]: url }))
  }

  async function compareVersions(g: { base: string; versions: ArtifactRef[] }) {
    const [older, newer] = [g.versions[0], g.versions[g.versions.length - 1]]
    const read = async (a: ArtifactRef) => {
      const href = artifactHref(a.url) || ''
      const res = await fetch(href, { headers: authHeaders(false) })
      return res.ok ? (await res.text()).split('\n') : []
    }
    const [fromLines, toLines] = await Promise.all([read(older), read(newer)])
    setDiff({ from: older.name, to: newer.name, lines: lineDiff(fromLines, toLines) })
  }

  const openInNewTab = focused ? () => openArtifactInNewTab(focused) : undefined

  // Mobile (below lg): a true bottom sheet — slides up, not in from the right
  // (audit P6). Desktop keeps the docked right-hand panel; fullscreen stays a
  // full overlay on both.
  const sheet = !fullscreen && !isDesktopViewport

  return (
    <motion.aside
      initial={sheet ? { y: 400 } : { x: 400, opacity: 0 }}
      animate={sheet ? { y: 0 } : { x: 0, opacity: 1 }}
      exit={sheet ? { y: 400 } : { x: 400, opacity: 0 }}
      transition={{ type: 'spring', stiffness: 320, damping: 34 }}
      style={fullscreen ? undefined : isDesktopViewport ? { width } : undefined}
      className={
        fullscreen
          ? 'fixed inset-0 z-50 flex p-3 pt-[max(0.75rem,env(safe-area-inset-top))] pb-[max(0.75rem,env(safe-area-inset-bottom))]'
          : sheet
            ? 'fixed inset-x-0 bottom-0 z-40 flex flex-col h-[85dvh] px-2.5 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]'
            : 'fixed lg:relative inset-y-0 right-0 z-40 lg:z-auto flex w-full max-w-[92vw] sm:max-w-[440px] lg:max-w-none shrink-0 px-2.5 sm:px-3 lg:p-3 h-full pt-[max(0.625rem,env(safe-area-inset-top))] pb-[max(0.625rem,env(safe-area-inset-bottom))] lg:pt-3 lg:pb-3'
      }
    >
      <div className="glass-strong rounded-2xl h-full w-full flex flex-col overflow-hidden shadow-panel relative">
        {sheet && (
          <div className="pt-1 flex justify-center shrink-0" aria-hidden="true">
            <span className="w-10 h-1 rounded-full bg-white/15" />
          </div>
        )}
        {/* Drag handle (desktop resize, persisted) */}
        {!fullscreen && (
          <div
            onPointerDown={onDragStart}
            onPointerMove={onDragMove}
            onPointerUp={onDragEnd}
            onPointerCancel={onDragEnd}
            title="Drag to resize"
            className="hidden lg:flex absolute left-0 inset-y-0 w-1.5 z-10 cursor-col-resize items-center justify-center group"
          >
            <span className="w-0.5 h-10 rounded-full bg-white/10 group-hover:bg-[#c96442]/60 transition" />
          </div>
        )}

        {/* Header */}
        <div className="flex items-center gap-2.5 px-4 py-3 border-b border-white/5 shrink-0">
          {focused && onBackToList ? (
            <button onClick={onBackToList} className="p-1 -ml-1 rounded-lg hover:bg-white/5 text-slate-400 hover:text-slate-200 transition" title="Back to list"><ChevronLeft size={16} /></button>
          ) : (
            <div className="w-2 h-2 rounded-full bg-[#c96442]" />
          )}
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold text-slate-100 truncate">{focused ? focused.name : 'Artifacts'}</div>
            <div className="text-[11px] text-slate-400 truncate">
              {focused ? focused.kind.toUpperCase() : `${artifacts.length} item${artifacts.length === 1 ? '' : 's'}`}
            </div>
          </div>
          <button onClick={() => setFullscreen((v) => !v)} className="p-1 rounded-lg hover:bg-white/5 text-slate-400 hover:text-slate-200 transition" title={fullscreen ? 'Exit fullscreen' : 'Fullscreen'}>
            {fullscreen ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
          </button>
          <button onClick={onClose} className="p-1 rounded-lg hover:bg-white/5 text-slate-400 hover:text-slate-200 transition" title="Close"><X size={16} /></button>
        </div>

        {/* ── Focused artifact view ─────────────────────────────────────── */}
        {focused && (
          <>
            <div className="flex items-center gap-2 px-3 py-2 border-b border-white/5 shrink-0 overflow-x-auto">
              {(['preview', 'raw', 'sandbox'] as Tab[])
                .filter((t) => t !== 'sandbox' || isHtml)
                .map((t) => (
                  <button key={t} onClick={() => { setTab(t); setSandboxError(null) }}
                    className={`px-2.5 py-1 rounded-lg text-[11px] transition ${tab === t ? 'bg-white/10 text-slate-200' : 'text-slate-400 hover:text-slate-300'}`}>
                    {t === 'preview' ? 'Preview' : t === 'raw' ? 'Raw' : 'Sandbox'}
                  </button>
                ))}
              <span className="flex-1" />
              {isHtml && tab === 'sandbox' && (
                <>
                  {(['desktop', 'tablet', 'mobile'] as ArtifactDevice[]).map((d) => (
                    <button key={d} onClick={() => setDevice(d)} title={`Preview at ${d} size`}
                      className={`p-1 rounded-lg transition ${device === d ? 'bg-white/10 text-slate-200' : 'text-slate-400 hover:text-slate-300'}`}>
                      {d === 'desktop' ? <Monitor size={13} /> : d === 'tablet' ? <Tablet size={13} /> : <Smartphone size={13} />}
                    </button>
                  ))}
                  <button onClick={() => { setNonce((n) => n + 1); setSandboxError(null) }} title="Refresh preview" className="p-1 rounded-lg text-slate-400 hover:text-slate-300 transition"><RefreshCw size={13} /></button>
                </>
              )}
              {openInNewTab && (
                <button onClick={openInNewTab} title="Open in new tab (short-lived private link)" className="p-1 rounded-lg text-slate-400 hover:text-slate-300 transition"><ExternalLink size={13} /></button>
              )}
            </div>

            {/* Content */}
            <div className="flex-1 min-h-0 overflow-auto p-3">
              {tab === 'preview' && focused.kind === 'image' && (
                <div className="relative">
                  {focusImage ? (
                    <button type="button" onClick={() => setLightboxOpen(true)} className="block w-full group" aria-label={`Open ${focused.name} fullscreen`}>
                      <img src={focusImage} alt={focused.name} loading="lazy" decoding="async"
                        className="w-full rounded-xl border border-white/10 transition group-hover:border-white/20" />
                      <span className="absolute top-2 right-2 p-1.5 rounded-lg bg-black/60 text-slate-200 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition" title="Open fullscreen">
                        <Maximize2 size={14} />
                      </span>
                    </button>
                  ) : (
                    <div className="w-full aspect-[4/3] rounded-xl border border-white/10 shimmer" aria-hidden="true" />
                  )}
                </div>
              )}
              {tab === 'preview' && isVideoArtifact(focused) && <VideoPlayer a={focused} className="w-full" />}
              {tab === 'preview' && isPdf && <PdfView a={focused} />}
              {tab === 'preview' && isSheet && <SheetView a={focused} />}
              {tab === 'preview' && isMermaid && (mermaidText.text ? <MermaidView code={mermaidText.text} /> : <LoadingShim />)}
              {tab === 'preview' && !isPdf && !isSheet && !isMermaid && focused.kind !== 'image' && !isVideoArtifact(focused) && (
                textLoading ? <LoadingShim /> :
                /\.(md|txt)$/i.test(focused.name) && textContent !== null ? (
                  <div className="text-[13px] leading-relaxed text-slate-200"><Markdown content={textContent.slice(0, 20000)} /></div>
                ) : textContent !== null ? (
                  <pre className="text-[12px] leading-relaxed text-slate-300 whitespace-pre-wrap font-mono">{textContent.slice(0, 20000)}</pre>
                ) : null
              )}
              {tab === 'raw' && (textLoading ? <LoadingShim /> : (
                <pre className="text-[12px] leading-relaxed text-slate-400 whitespace-pre-wrap font-mono">{(textContent || '').slice(0, 30000)}</pre>
              ))}
              {tab === 'sandbox' && isHtml && (
                <div className="h-full flex flex-col gap-2">
                  {sandboxError && (
                    <div className="rounded-xl border border-rose-500/20 bg-rose-500/[0.04] px-3 py-2 flex items-start gap-2">
                      <span className="text-[12px] text-rose-300 flex-1 min-w-0 break-all">{sandboxError}</span>
                      {onFixError && (
                        <button type="button" onClick={fixPrompt} className="shrink-0 inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-[#c96442] text-white text-[11px] font-medium hover:bg-[#b5593a] transition">
                          <Wrench size={11} /> Fix error
                        </button>
                      )}
                    </div>
                  )}
                  <div className="flex-1 min-h-0 flex justify-center">
                    {textContent !== null ? (
                      <iframe
                        key={`${focused.id}-${nonce}`}
                        title={`Sandbox: ${focused.name}`}
                        srcDoc={withErrorBridge(textContent)}
                        // No allow-same-origin: the document runs in an opaque
                        // origin and cannot touch the parent app or its storage.
                        sandbox="allow-scripts allow-popups allow-forms"
                        style={{ width: DEVICE_WIDTH[device] }}
                        className="h-full max-h-full rounded-xl border border-white/10 bg-white"
                      />
                    ) : <LoadingShim />}
                  </div>
                </div>
              )}
            </div>

            {/* Footer actions */}
            <div className="px-3 py-2.5 border-t border-white/5 space-y-2 shrink-0">
              {focused.kind === 'image' && lightboxOpen && (
                <Lightbox
                  images={artifacts.filter((a) => a.kind === 'image')}
                  startIndex={Math.max(0, artifacts.filter((a) => a.kind === 'image').findIndex((a) => a.id === focused.id))}
                  onClose={() => setLightboxOpen(false)}
                />
              )}
              <div className="flex gap-2">
                <button onClick={() => downloadArtifact(focused, artifactHref(focused.url))}
                  className="flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-xl glass hover:bg-white/5 text-[12px] text-slate-200 transition">
                  <DownloadIcon size={13} /> Download
                </button>
                <button onClick={() => togglePublish(focused)}
                  className="flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-xl glass hover:bg-white/5 text-[12px] text-slate-200 transition">
                  <Share2 size={13} /> {published[focused.id] ? 'Unpublish' : 'Publish link'}
                </button>
              </div>
              {published[focused.id] && (
                <div className="text-[11px] text-slate-400 break-all flex items-center gap-1.5">
                  <a href={published[focused.id]} target="_blank" rel="noreferrer" className="text-sky-400 hover:underline">{published[focused.id]}</a>
                  <button onClick={() => navigator.clipboard?.writeText(published[focused.id])} className="text-slate-400 hover:text-slate-300" title="Copy"><Copy size={11} /></button>
                </div>
              )}
            </div>
          </>
        )}

        {/* ── List view ─────────────────────────────────────────────────── */}
        {!focused && (
          <>
            {diff && (
              <div className="border-b border-white/5 bg-black/20 shrink-0">
                <div className="flex items-center justify-between px-4 py-2">
                  <div className="text-[11px] text-slate-400 truncate">{diff.from} → {diff.to}</div>
                  <button onClick={() => setDiff(null)} className="text-slate-400 hover:text-slate-300"><X size={13} /></button>
                </div>
                <div className="max-h-56 overflow-auto px-3 pb-2 font-mono text-[11px] leading-relaxed">
                  {diff.lines.map((l, i) => (
                    <div key={i} className={l.sign === '+' ? 'text-emerald-400' : l.sign === '-' ? 'text-rose-400' : 'text-slate-400'}>
                      <span className="select-none">{l.sign} </span>{l.text || '\u00a0'}
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="flex-1 overflow-y-auto p-3 space-y-1.5 min-h-0">
              {/* In-flight artifact builds (per-artifact streaming state) */}
              {buildingKinds.map((k, i) => (
                <div key={`${k}-${i}`} className="rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-2.5 flex items-center gap-2.5">
                  <FileDown size={15} className="text-[#c96442] shrink-0 animate-pulse" />
                  <span className="flex-1 min-w-0">
                    <span className="block text-[13px] text-slate-300 truncate">{BUILDING_LABEL[k] || 'Building…'}</span>
                    <span className="block h-1.5 mt-1 rounded-full shimmer" style={{ width: '60%' }} />
                  </span>
                </div>
              ))}

              {groups.length === 0 && buildingKinds.length === 0 && (
                <div className="h-full flex flex-col items-center justify-center text-center text-slate-500 gap-2">
                  <FileText size={28} className="text-slate-500" />
                  <p className="text-xs max-w-[200px]">Generated files and code snippets appear here as the agent creates them.</p>
                </div>
              )}
              {groups.map((g) => {
                const latest = g.versions[g.versions.length - 1]
                return (
                  <div key={g.base} className="glass rounded-xl overflow-hidden">
                    <button
                      onClick={() => onFocusArtifact?.(latest.id)}
                      className="w-full flex items-center gap-2.5 px-3 py-2.5 text-left hover:bg-white/[0.03] transition"
                    >
                      <IconForKind latest={latest} />
                      <span className="flex-1 min-w-0">
                        <span className="block text-[13px] text-slate-200 truncate">{g.base}</span>
                        {g.versions.length > 1 && (
                          <span className="text-[10px] text-slate-400">{g.versions.length} versions</span>
                        )}
                      </span>
                      <span className="text-[10px] uppercase tracking-wide text-slate-400">{latest.kind}</span>
                    </button>
                    {g.versions.length > 1 && (
                      <div className="border-t border-white/5 px-3 py-1.5 space-y-1">
                        <button onClick={() => compareVersions(g)}
                          className="flex items-center gap-1.5 w-full text-left text-[11px] text-[#c96442] hover:underline pb-1">
                          <GitCompare size={11} /> Compare {g.versions.length} versions
                        </button>
                        {g.versions.map((v) => (
                          <button key={v.id} onClick={() => downloadArtifact(v, artifactHref(v.url))}
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
          </>
        )}
      </div>
    </motion.aside>
  )
}

function LoadingShim() {
  return (
    <div className="flex items-center gap-2 justify-center py-10 text-[12px] text-slate-400">
      <span className="shimmer inline-block h-2.5 w-2.5 rounded-full" /> Loading…
    </div>
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
  if (latest.kind === 'image') return <ImageIcon size={16} className="text-[#d8a08a] shrink-0" />
  if (/\.(md|txt)$/i.test(latest.name)) return <FileText size={16} className="text-[#c96442] shrink-0" />
  if (/\.(js|ts|jsx|tsx|py|go|rs|rb)$/i.test(latest.name)) return <Code size={16} className="text-[#6ee7a0] shrink-0" />
  return <File size={16} className="text-slate-400 shrink-0" />
}
