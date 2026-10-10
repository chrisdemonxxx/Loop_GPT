'use client'

import { useQuery } from '@tanstack/react-query'
import Link from 'next/link'
import { API_URL, authHeaders } from '../lib/api'
import { AppPage } from '../components/AppPage'
import { ErrorState, LoadingState, cardCls } from '@loop/ui'
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
  const files = useQuery<ArtifactRef[]>({
    queryKey: ['artifacts'],
    queryFn: async () => {
      const res = await fetch(`${API_URL}/api/conversations?artifacts=1`, { headers: authHeaders() })
      if (!res.ok) throw new Error('load')
      const refs = asRefs(await res.json())
      if (!refs) throw new Error('load')
      return refs
    },
    enabled: typeof window !== 'undefined',
    retry: false,
  })
  const rows = files.data ?? null

  return (
    <AppPage title="Files" back={{ href: '/chat', label: 'Chat' }}>
      {files.isError ? (
        <ErrorState title="Couldn't load files." onRetry={() => { void files.refetch() }} />
      ) : rows === null ? (
        <LoadingState label="Loading files" />
      ) : rows.length === 0 ? (
        <p className="text-sm text-[var(--ink-secondary)]">{EMPTY}</p>
      ) : (
        <ul className="space-y-2">
          {rows.map((a) => (
            <li key={a.id}>
              <Link href={`/artifact/?id=${encodeURIComponent(a.id)}`} className={`flex items-center gap-2 px-3 py-2 ${cardCls}`}>
                <span className="text-sm text-[var(--ink-primary)] truncate">{a.name}</span>
                <span className="text-2xs text-[var(--ink-muted)] shrink-0">{a.kind}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </AppPage>
  )
}
