'use client'

import { Suspense, useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { Badge, LoadingState, SectionHeader, btnOutline, btnPrimary, cardCls } from '@loop/ui'
import {
  getPublicShare,
  remixPublicShare,
  toUserFacingError,
  type PublicShare,
} from '@loop/loopit-client'
import { AppPage } from '../../components/AppPage'
import { useToast } from '../../lib/toast'
import { ErrorNotice } from '../shell'

export default function PublicSharePage() {
  return (
    <Suspense fallback={<AppPage title="Shared app"><LoadingState variant="card" label="Loading share" /></AppPage>}>
      <ShareRoute />
    </Suspense>
  )
}

function ShareRoute() {
  const shareId = useSearchParams().get('id')
  if (!shareId) {
    return (
      <AppPage title="Shared app" back={{ href: '/build', label: 'Build' }}>
        <ErrorNotice error={{ kind: 'not_found', title: 'Missing share', message: 'Add ?id= to the URL.', action: 'Open a share link from project settings.' }} />
      </AppPage>
    )
  }
  return <ShareView shareId={shareId} />
}

function ShareView({ shareId }: { shareId: string }) {
  const router = useRouter()
  const toast = useToast()
  const [share, setShare] = useState<PublicShare | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const payload = await getPublicShare(shareId)
        if (!cancelled) setShare(payload)
      } catch (cause) {
        if (!cancelled) setError(cause)
      }
    })()
    return () => { cancelled = true }
  }, [shareId])

  if (error) {
    return (
      <AppPage title="Shared app" back={{ href: '/build', label: 'Build' }}>
        <ErrorNotice error={toUserFacingError(error)} />
      </AppPage>
    )
  }
  if (!share) {
    return <AppPage title="Shared app"><LoadingState variant="card" label="Loading share" /></AppPage>
  }

  const previewHref = share.production_url
    ? (share.production_url.startsWith('http') ? share.production_url : share.production_url)
    : null

  return (
    <AppPage
      title={share.title}
      description="Published app preview. Remix forks the latest checkpoint without chat history or secrets."
      back={{ href: '/build', label: 'Build' }}
      actions={(
        <div className="flex flex-wrap gap-2">
          {previewHref && (
            <a href={previewHref} target="_blank" rel="noreferrer" className={btnOutline}>Open app</a>
          )}
          {share.remix_allowed && (
            <button
              type="button"
              className={btnPrimary}
              disabled={busy}
              onClick={async () => {
                setBusy(true)
                try {
                  const created = await remixPublicShare(shareId)
                  toast.push('success', 'Remixed into your projects')
                  router.push(`/build/projects/?id=${encodeURIComponent(created.project_id)}`)
                } catch (cause) {
                  toast.push('error', toUserFacingError(cause).message)
                } finally {
                  setBusy(false)
                }
              }}
            >
              {busy ? 'Remixing…' : 'Remix'}
            </button>
          )}
        </div>
      )}
    >
      <section className={`${cardCls} p-4 space-y-3`}>
        <div className="flex items-center gap-2">
          <SectionHeader title="Share" />
          <Badge tone="neutral">{share.visibility === 'public_remix' ? 'Public remix' : 'Link'}</Badge>
        </div>
        {previewHref ? (
          <iframe
            title="Published app"
            src={previewHref}
            className="w-full min-h-[28rem] rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-1)]"
            sandbox="allow-scripts allow-same-origin"
          />
        ) : (
          <p className="text-ui-xs text-[var(--ink-muted)]">
            This project is shareable but has no live publish URL yet. Publish from the build run, then refresh.
          </p>
        )}
        {!share.remix_allowed && (
          <p className="text-3xs text-[var(--ink-muted)]">
            Remix is off for link-only shares. Ask the owner to set visibility to Public remix.
          </p>
        )}
        <Link href="/build/templates" className="text-ui-xs text-[var(--accent-text)] hover:underline">Browse templates</Link>
      </section>
    </AppPage>
  )
}
