'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Badge, EmptyState, LoadingState, SectionHeader, btnGhost, btnOutline, btnPrimary, cardCls } from '@loop/ui'
import {
  isServiceMissing,
  isUnreachable,
  listTemplates,
  remixTemplate,
  toUserFacingError,
  type BuildTemplate,
} from '@loop/loopit-client'
import { AppPage } from '../../components/AppPage'
import { useToast } from '../../lib/toast'
import { ErrorNotice } from '../shell'

export default function BuildTemplatesPage() {
  const router = useRouter()
  const toast = useToast()
  const [items, setItems] = useState<BuildTemplate[] | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const list = await listTemplates()
        if (!cancelled) setItems(list)
      } catch (cause) {
        if (!cancelled) setError(cause)
      }
    })()
    return () => { cancelled = true }
  }, [])

  const facing = error ? toUserFacingError(error) : null
  const offline = error ? isUnreachable(error) || isServiceMissing(error) : false

  return (
    <AppPage
      title="Templates"
      description="Curated starters and recipe scaffolds. Preview the prompt, then Remix to start a build."
      back={{ href: '/build', label: 'All builds' }}
      actions={<Link href="/build/projects" className={btnOutline}>Build projects</Link>}
    >
      {facing && (
        <ErrorNotice
          error={offline ? {
            kind: 'unavailable',
            title: 'Build service unreachable',
            message: 'The Build service is not reachable.',
            action: 'Retry in a moment.',
          } : facing}
        />
      )}
      {items === null && !error && <LoadingState variant="card" label="Loading templates" />}
      {items && items.length === 0 && (
        <EmptyState title="No templates" body="Templates will show up here when starters are available." />
      )}
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        {(items ?? []).map((template) => (
          <div key={template.id} className={`p-4 ${cardCls} flex flex-col gap-3`}>
            <div className="flex items-start justify-between gap-2">
              <div>
                <SectionHeader title={template.title} />
                <p className="mt-1 text-ui-xs text-[var(--ink-muted)] line-clamp-3">{template.description}</p>
              </div>
              <Badge tone="neutral">{template.stack}</Badge>
            </div>
            <p className="text-3xs text-[var(--ink-muted)] font-mono line-clamp-2">{template.prompt_seed}</p>
            <div className="mt-auto flex flex-wrap gap-2">
              <button
                type="button"
                className={btnPrimary}
                disabled={busyId === template.id}
                onClick={async () => {
                  setBusyId(template.id)
                  try {
                    const created = await remixTemplate(template.id)
                    toast.push('success', 'Remixed — starting build')
                    router.push(`/build/?run=${encodeURIComponent(created.run_id)}`)
                  } catch (cause) {
                    toast.push('error', toUserFacingError(cause).message)
                  } finally {
                    setBusyId(null)
                  }
                }}
              >
                {busyId === template.id ? 'Starting…' : 'Remix'}
              </button>
              <Link href={`/build/?prompt=${encodeURIComponent(template.prompt_seed)}`} className={btnGhost}>
                Preview prompt
              </Link>
            </div>
          </div>
        ))}
      </div>
    </AppPage>
  )
}
