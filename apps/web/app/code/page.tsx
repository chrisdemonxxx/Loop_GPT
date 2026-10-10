'use client'

import { useEffect } from 'react'

/**
 * /code (blueprint §9.8): the Loop Code alias. Loop Code is the CLI and
 * developer surface, which lives at /developer (API keys, usage, console).
 * Build has its own route (/build) and nav entry; this alias never targets it.
 */
export default function CodeRedirect() {
  useEffect(() => { window.location.replace('/developer') }, [])
  return (
    <main className="flex min-h-dvh items-center justify-center bg-[var(--bg-base)] text-[var(--ink-muted)]">
      <p className="text-ui-sm" role="status">Opening Loop Code (developer API)…</p>
    </main>
  )
}
