'use client'

/** Agent frames filmstrip: image artifacts fetched with auth, newest-last,
 *  with a pulse on the newest frame while the run is active. */
import { useEffect, useState } from 'react'
import { authHeaders } from '../../lib/api'

interface ArtifactRef { id: string; name: string; url: string; kind: string; mimeType?: string }

export function FramesStrip({ artifacts, active }: { artifacts: ArtifactRef[]; active: boolean }) {
  const [frames, setFrames] = useState<Record<string, string>>({})
  const artifactKey = artifacts.map((a) => a.id).join(',')
  useEffect(() => {
    let stop = false
    const wanted = new Set<string>()
    const load = async () => {
      const images = artifacts.filter((a) => a.kind === 'image' || (a.mimeType || '').startsWith('image/'))
      for (const art of images) {
        wanted.add(art.id)
        if (frames[art.id]) continue
        try {
          const res = await fetch(art.url, { headers: authHeaders(false) })
          if (!res.ok) continue
          const blob = await res.blob()
          if (stop) return
          setFrames((f) => ({ ...f, [art.id]: URL.createObjectURL(blob) }))
        } catch { /* transient; next refresh retries */ }
      }
      setFrames((f) => Object.fromEntries(Object.entries(f).filter(([id]) => wanted.has(id))))
    }
    load()
    return () => { stop = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [artifactKey])

  const rendered = artifacts.filter((a) => frames[a.id])
  if (!rendered.length) return null
  return (
    <div className="mb-2">
      <div className="mb-1 flex items-center gap-2 text-[11px] text-slate-500">
        Agent frames (what it sees, newest last)
        {active && <span className="relative flex h-1.5 w-1.5"><span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-violet-400 opacity-75"></span><span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-violet-500"></span></span>}
      </div>
      <div className="flex gap-2 overflow-x-auto pb-1">
        {rendered.map((a) => (
          <a key={a.id} href={frames[a.id]} target="_blank" rel="noreferrer" className="shrink-0">
            <img src={frames[a.id]} alt={a.name} title={a.name}
              className="h-24 rounded-md ring-1 ring-slate-700/60 hover:ring-violet-500/70" />
          </a>
        ))}
      </div>
    </div>
  )
}