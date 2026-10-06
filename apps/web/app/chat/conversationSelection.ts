import { useEffect, useRef } from 'react'

/** Conversation id carried on /chat?conversation=, or null for a new chat. */
export function conversationIdFromLocation(search: string): string | null {
  const raw = search.startsWith('?') ? search.slice(1) : search
  const id = new URLSearchParams(raw).get('conversation')
  return id && id.trim() ? id : null
}

/** Point the current /chat URL at the selected conversation. Does not navigate or create one. */
export function replaceConversationQuery(id: string | null) {
  if (typeof window === 'undefined') return
  const url = new URL(window.location.href)
  if (id) url.searchParams.set('conversation', id)
  else url.searchParams.delete('conversation')
  const next = `${url.pathname}${url.search}${url.hash}`
  const current = `${window.location.pathname}${window.location.search}${window.location.hash}`
  if (next !== current) window.history.replaceState(window.history.state, '', next)
}

/**
 * Apply ?conversation= once on load, then keep the query in step with the
 * selection. A cleared selection removes the id so a refresh cannot reopen it.
 */
export function useConversationQuery(currentId: string | null, setCurrentId: (id: string) => void) {
  const hydrated = useRef(false)
  useEffect(() => {
    if (!hydrated.current) {
      hydrated.current = true
      const fromUrl = conversationIdFromLocation(window.location.search)
      if (fromUrl && fromUrl !== currentId) {
        setCurrentId(fromUrl)
        return
      }
    }
    replaceConversationQuery(currentId)
  }, [currentId, setCurrentId])
}
