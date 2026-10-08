'use client'

import { useEffect, useState } from 'react'

/** Persistent banner while the browser reports no network. Hidden when online. */
export function OfflineBanner() {
  const [offline, setOffline] = useState(false)
  useEffect(() => {
    const sync = () => setOffline(typeof navigator !== 'undefined' && navigator.onLine === false)
    sync()
    window.addEventListener('offline', sync)
    window.addEventListener('online', sync)
    return () => {
      window.removeEventListener('offline', sync)
      window.removeEventListener('online', sync)
    }
  }, [])
  if (!offline) return null
  return (
    <div role="status" className="fixed top-0 inset-x-0 z-[80] bg-amber-400 px-3 py-1.5 text-center text-[12px] font-medium text-amber-950">
      You are offline. New messages will send when the connection returns.
    </div>
  )
}
