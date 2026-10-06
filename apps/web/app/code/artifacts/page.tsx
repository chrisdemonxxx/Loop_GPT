'use client'

import { useEffect } from 'react'

/** /code/artifacts (blueprint §9.8): artifacts live at /artifacts. */
export default function CodeArtifactsRedirect() {
  useEffect(() => { window.location.replace('/artifacts') }, [])
  return (
    <main className="flex min-h-screen items-center justify-center bg-[#08080a] text-slate-400">
      <p className="text-[13px]" role="status">Opening artifacts…</p>
    </main>
  )
}