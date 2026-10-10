'use client'

import Link from 'next/link'
import { ErrorState, btnPrimary } from '@loop/ui'
import type { UserFacingError } from '@loop/loopit-client'

/** A Build API failure in the shared ErrorState, with Sign in for auth errors. */
export function ErrorNotice({ error, onRetry }: { error: UserFacingError; onRetry?: () => void }) {
  return (
    <ErrorState
      title={error.title}
      message={error.message}
      hint={error.action}
      tone={error.kind === 'unavailable' ? 'neutral' : 'danger'}
      onRetry={onRetry}
      actions={error.kind === 'auth' ? <Link href="/login" className={btnPrimary}>Sign in</Link> : undefined}
    />
  )
}
