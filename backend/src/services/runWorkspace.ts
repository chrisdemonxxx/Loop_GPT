import { ensurePersonalWorkspace, requireMembership, workspaceDb, workspaceTransaction, WorkspaceError } from './workspaces'

/** Pin legacy personal conversations once. Never move an existing conversation. */
export async function prepareRunConversation(userId: string, conversationId: string, title: string, requestedWorkspaceId?: string,
  validateSelection?: (workspaceId: string) => Promise<void>) {
  const db = workspaceDb()
  const existing = conversationId === 'new' ? null : await db.conversation.findFirst({ where: { id: conversationId, userId } })
  if (conversationId !== 'new' && !existing) throw new WorkspaceError(404, 'Conversation not found')
  const workspaceId = existing?.workspaceId || (existing
    ? (await ensurePersonalWorkspace(userId)).id
    : requestedWorkspaceId || (await ensurePersonalWorkspace(userId)).id)
  if (requestedWorkspaceId && workspaceId !== requestedWorkspaceId) throw new WorkspaceError(409, 'Conversation belongs to a different workspace')
  await requireMembership(userId, workspaceId, 'editor')
  // Validate selected connections before creating or binding a conversation.
  await validateSelection?.(workspaceId)
  return workspaceTransaction(async (tx) => {
    const member = await tx.workspaceMember.findUnique({ where: { workspaceId_userId: { workspaceId, userId } } })
    if (!member || !['owner', 'editor'].includes(member.role)) throw new WorkspaceError(403, 'Workspace execution permission required')
    if (!existing) return tx.conversation.create({ data: { userId, workspaceId, title: title.slice(0, 50) || 'New Chat' } })
    if (!existing.workspaceId) {
      const assigned = await tx.conversation.updateMany({ where: { id: conversationId, userId, workspaceId: null }, data: { workspaceId } })
      if (assigned.count !== 1) throw new WorkspaceError(409, 'Conversation changed; retry the request')
    }
    const conversation = await tx.conversation.findFirst({ where: { id: conversationId, userId, workspaceId } })
    if (!conversation) throw new WorkspaceError(404, 'Conversation not found')
    return conversation
  })
}
