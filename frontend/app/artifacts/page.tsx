'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { API_URL, authHeaders } from '../lib/api'
import type { ArtifactRef } from '../lib/stream'

const EMPTY = 'Generated files and code snippets appear here as the agent creates them.'

function asRefs(data: unknown): ArtifactRef[] | null {
  if (!Array.isArray(data)) return null
  const refs: ArtifactRef[] = []
  for (const item of data) {
    if (!item || typeof item !== 'object') continue
    const row = item as Record<string, unknown>
    if (typeof row.id !== 'string' || !row.id || typeof row.name !== 'string' || !row.name) continue
    refs.push({
      id: row.id,
      name: row.name,
      kind: typeof row.kind === 'string' && row.kind ? row.kind : 'file',
      url: typeof row.url === 'string' ? row.url : undefined,
      mimeType: typeof row.mimeType === 'string' ? row.mimeType : undefined,
    })
  }
  return refs
}

/** One read of artifact refs saved on non-incognito messages. */
export default function ArtifactsPage() {
  const [rows, setRows] = useState<ArtifactRef[] | null>(null)
  const [error, setError] = useState(false)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let cancelled = false
    fetch(`${API_URL}/api/conversations?artifacts=1`, { headers: authHeaders() })
      .then(async (res) => {
        if (!res.ok) throw new Error('load')
        const refs = asRefs(await res.json())
        if (!refs) throw new Error('load')
        if (!cancelled) { setRows(refs); setError(false) }
      })
      .catch(() => { if (!cancelled) setError(true) })
    return () => { cancelled = true }
  }, [attempt])

  return (
    <main className="min-h-screen bg-[#08080a] text-slate-200">
      <div className="max-w-3xl mx-auto px-5 py-8">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-xl font-semibold text-slate-100">Files</h1>
          <Link href="/chat" className="text-sm text-slate-500 hover:text-slate-300">Back</Link>
        </div>
        {error ? (
          <div>
            <p className="text-sm text-rose-400">{"Couldn't load files."}</p>
            <button type="button" onClick={() => setAttempt((n) => n + 1)} className="mt-2 text-sm text-rose-300 underline">Retry</button>
          </div>
        ) : rows === null ? (
          <p className="text-sm text-slate-500">Loading...</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-slate-400">{EMPTY}</p>
        ) : (
          <ul className="space-y-2">
            {rows.map((a) => (
              <li key={a.id}>
                <Link href={`/artifact/${encodeURIComponent(a.id)}`} className="flex items-center gap-2 rounded-xl border border-white/[0.06] px-3 py-2 hover:bg-white/[0.04]">
                  <span className="text-sm text-slate-100 truncate">{a.name}</span>
                  <span className="text-[11px] text-slate-500 shrink-0">{a.kind}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </main>
  )
}
