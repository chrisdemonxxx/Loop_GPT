import { useEffect } from 'react'

/** Conversation id carried on /chat?conversation=, or null for a new chat. */
export function conversationIdFromLocation(search: string): string | null {
  const raw = search.startsWith('?') ? search.slice(1) : search
  const id = new URLSearchParams(raw).get('conversation')
  return id && id.trim() ? id : null
}

/** Select the conversation encoded in the current URL. Does not create one. */
export function useSelectConversationFromQuery(setCurrentConversationId: (id: string) => void) {
  useEffect(() => {
    const id = conversationIdFromLocation(window.location.search)
    if (id) setCurrentConversationId(id)
  }, [setCurrentConversationId])
}
