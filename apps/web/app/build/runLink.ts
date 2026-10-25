/**
 * Conversation id already present on a run payload.
 * The typed run has no conversation field; this only reads one if the JSON includes it.
 */
export function runConversationId(run: object | null | undefined): string | null {
  if (!run) return null
  const record = run as Record<string, unknown>
  const raw = record.conversation_id ?? record.conversationId
  if (typeof raw !== 'string') return null
  const id = raw.trim()
  return id.length > 0 ? id : null
}
