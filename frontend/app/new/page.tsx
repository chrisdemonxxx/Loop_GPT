'use client'

import { useEffect } from 'react'

/**
 * /new (blueprint §4.1): the new-chat screen. In this product that screen IS
 * /chat (hero greeting + composer + suggestion cards — the PromptChips
 * analogue; contract team/CONTRACT_S3_ROUTES.md). This route is the blueprint
 * alias: land on /chat, replacing history so /new does not sit in the stack.
 */
export default function NewChatRedirect() {
  useEffect(() => {
    window.location.replace('/chat')
  }, [])
  return (
    <main className="flex min-h-screen items-center justify-center bg-[#08080a] text-slate-400">
      <p className="text-[13px]" role="status">Starting a new chat…</p>
    </main>
  )
}