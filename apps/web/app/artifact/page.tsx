'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useQuery } from '@tanstack/react-query'
import { API_URL, authHeaders } from '../lib/api'
import ArtifactsPanel from '../components/chat/ArtifactsPanel'
import { AppPage } from '../components/AppPage'
import { ErrorState, LoadingState } from '@loop/ui'
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

  useEffect(() => {
    setId(fileIdFromLocation(window.location.search))
  }, [])

  const file = useQuery<ArtifactRef>({
    queryKey: ['artifact-file', id],
    queryFn: async () => {
      if (!id) throw new Error('open')
      const res = await fetch(`${API_URL}/api/files/${encodeURIComponent(id)}`, { headers: authHeaders() })
      if (!res.ok) throw new Error('open')
      const data = await res.json()
      if (!data || data.id !== id || typeof data.name !== 'string') throw new Error('open')
      return {
        id: data.id,
        name: data.name,
        kind: kindFor(data.name, typeof data.mimeType === 'string' ? data.mimeType : ''),
        url: typeof data.url === 'string' ? data.url : `/api/files/${data.id}/content`,
        mimeType: typeof data.mimeType === 'string' ? data.mimeType : undefined,
      } as ArtifactRef
    },
    enabled: typeof window !== 'undefined' && !!id,
    retry: false,
  })

  const failed = id === '' || file.isError

  if (failed) {
    return (
      <AppPage title="File">
        <ErrorState title="Couldn't open this file." onRetry={() => { void file.refetch() }} />
        <div className="mt-3">
          <Link href="/artifacts" className="text-sm text-[var(--ink-secondary)] underline">Back to files</Link>
        </div>
      </AppPage>
    )
  }

  if (!file.data) {
    return <AppPage title="File"><LoadingState label="Loading file" /></AppPage>
  }

  return (
    <div className="min-h-screen bg-[var(--bg-base)]">
      <ArtifactsPanel
        artifacts={[file.data]}
        focusId={file.data.id}
        onClose={() => router.push('/artifacts')}
        onBackToList={() => router.push('/artifacts')}
      />
    </div>
  )
}
