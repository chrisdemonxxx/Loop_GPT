'use client'

import { useEffect } from 'react'

/** /code/customize (blueprint §9.8): the customize hub lives at /customize. */
export default function CodeCustomizeRedirect() {
  useEffect(() => { window.location.replace('/customize') }, [])
  return (
    <main className="flex min-h-screen items-center justify-center bg-[#08080a] text-slate-400">
      <p className="text-[13px]" role="status">Opening customize…</p>
    </main>
  )
}