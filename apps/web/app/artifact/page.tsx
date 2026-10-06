'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { API_URL, authHeaders } from '../lib/api'
import ArtifactsPanel from '../components/chat/ArtifactsPanel'
import type { ArtifactRef } from '../lib/stream'

function kindFor(name: string, mime: string): string {
  const n = name.toLowerCase()
  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('video/')) return 'video'
  if (mime === 'application/pdf' || n.endsWith('.pdf')) return 'pdf'
  if (n.endsWith('.html') || n.endsWith('.htm')) return 'html'
  if (n.endsWith('.csv') || mime === 'text/csv') return 'csv'
  if (n.endsWith('.xlsx') || n.endsWith('.xls') || mime.includes('spreadsheet')) return 'xlsx'
  if (n.endsWith('.mmd') || n.endsWith('.mermaid')) return 'mermaid'
  return 'file'
}

/** File id on /artifact/?id=, the static page nginx can serve for any id. */
function fileIdFromLocation(search: string): string {
  const raw = search.startsWith('?') ? search.slice(1) : search
  const id = new URLSearchParams(raw).get('id')
  return id && id.trim() ? id : ''
}

/** Open one private file. A miss does not create a file and is not the empty library. */
export default function ArtifactPage() {
  const router = useRouter()
  const [id, setId] = useState<string | null>(null)
  const [artifact, setArtifact] = useState<ArtifactRef | null>(null)
  const [error, setError] = useState(false)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    setId(fileIdFromLocation(window.location.search))
  }, [])

  useEffect(() => {
    if (id === null) return
    if (!id) { setError(true); return }
    let cancelled = false
    setError(false)
    setArtifact(null)
    fetch(`${API_URL}/api/files/${encodeURIComponent(id)}`, { headers: authHeaders() })
      .then(async (res) => {
        if (!res.ok) throw new Error('open')
        const data = await res.json()
        if (!data || data.id !== id || typeof data.name !== 'string') throw new Error('open')
        if (cancelled) return
        setArtifact({
          id: data.id,
          name: data.name,
          kind: kindFor(data.name, typeof data.mimeType === 'string' ? data.mimeType : ''),
          url: typeof data.url === 'string' ? data.url : `/api/files/${data.id}/content`,
          mimeType: typeof data.mimeType === 'string' ? data.mimeType : undefined,
        })
      })
      .catch(() => { if (!cancelled) setError(true) })
    return () => { cancelled = true }
  }, [id, attempt])

  if (error) {
    return (
      <main className="min-h-screen bg-[#08080a] text-slate-200 px-5 py-8">
        <p className="text-sm text-rose-400">{"Couldn't open this file."}</p>
        <button type="button" className="mt-2 text-sm text-rose-300 underline" onClick={() => setAttempt((n) => n + 1)}>Retry</button>
        <div className="mt-3">
          <Link href="/artifacts" className="text-sm text-slate-300 underline">Back to files</Link>
        </div>
      </main>
    )
  }

  if (!artifact) {
    return <main className="min-h-screen bg-[#08080a] text-slate-500 px-5 py-8">Loading...</main>
  }

  return (
    <div className="min-h-screen bg-[#08080a]">
      <ArtifactsPanel
        artifacts={[artifact]}
        focusId={artifact.id}
        onClose={() => router.push('/artifacts')}
        onBackToList={() => router.push('/artifacts')}
      />
    </div>
  )
}
