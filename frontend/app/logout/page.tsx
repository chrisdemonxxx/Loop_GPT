'use client'

import { useEffect } from 'react'
import { clearAuth } from '../lib/api'

/**
 * /logout (blueprint §4.1): a route-action, not a page. Clears this
 * browser's session and lands on /login. Static-export friendly.
 */
export default function LogoutPage() {
  useEffect(() => {
    clearAuth()
    window.location.replace('/login')
  }, [])
  return (
    <main className="flex min-h-screen items-center justify-center bg-[#08080a] text-slate-400">
      <p className="text-[13px]" role="status">Signing you out…</p>
    </main>
  )
}