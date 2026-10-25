'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'

/** Recents was a second copy of the chat sidebar. Chat owns that list. */
export default function RecentsPage() {
  const router = useRouter()
  useEffect(() => { router.replace('/chat') }, [router])
  return null
}
