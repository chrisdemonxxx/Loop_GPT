'use client'

import { useEffect } from 'react'

/**
 * /code (blueprint §9.8): the Code app shell. Our code surface is /developer
 * (real, shipped — API keys, usage, console). Nothing is plan-gated today, so
 * an upgrade gate would be fiction (contract team/CONTRACT_S3_ROUTES.md).
 */
export default function CodeRedirect() {
  useEffect(() => { window.location.replace('/developer') }, [])
  return (
    <main className="flex min-h-screen items-center justify-center bg-[#08080a] text-slate-400">
      <p className="text-[13px]" role="status">Opening Loop Code…</p>
    </main>
  )
}