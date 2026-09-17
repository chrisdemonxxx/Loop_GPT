import { randomUUID } from 'crypto'
import { Prisma } from '@prisma/client'
import { z } from 'zod'
import { prisma } from './prisma'

export class WorkspaceError extends Error {
  constructor(public readonly status: number, message: string) { super(message) }
}
export function workspaceDb() {
  if (!prisma) throw new WorkspaceError(503, 'Workspaces require a database')
  return prisma
}
export type WorkspaceRole = 'owner' | 'editor' | 'viewer'
const rank: Record<WorkspaceRole, number> = { viewer: 0, editor: 1, owner: 2 }
export const workspaceName = z.string().trim().min(1).max(100)

export async function workspaceTransaction<T>(operation: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  try {
    return await workspaceDb().$transaction(operation, { isolationLevel: 'Serializable' })
  } catch (error: any) {
    if (error?.code === 'P2034') throw new WorkspaceError(409, 'Concurrent workspace change; reload before retrying')
    throw error
  }
}

export async function requireMembership(userId: string, workspaceId: string, minimum: WorkspaceRole = 'viewer') {
  if (typeof userId !== 'string' || !userId || typeof workspaceId !== 'string' || !workspaceId) throw new WorkspaceError(404, 'Workspace not found')
  const member = await workspaceDb().workspaceMember.findUnique({ where: { workspaceId_userId: { workspaceId, userId } } })
  if (!member || !Object.prototype.hasOwnProperty.call(rank, member.role)) throw new WorkspaceError(404, 'Workspace not found')
  if (!Object.prototype.hasOwnProperty.call(rank, minimum)) throw new WorkspaceError(403, 'Invalid workspace permission')
  if (rank[member.role as WorkspaceRole] < rank[minimum]) throw new WorkspaceError(403, 'Insufficient workspace permission')
  return member
}

export async function ensurePersonalWorkspace(userId: string) {
  const db = workspaceDb()
  if (!userId || !await db.user.findUnique({ where: { id: userId }, select: { id: true } })) throw new WorkspaceError(401, 'Account not found')
  const existing = await db.workspace.findUnique({ where: { personalOwnerId: userId } })
  if (existing) return existing
  try {
    return await db.workspace.create({ data: {
      id: `personal-${userId}`, name: 'Personal', personalOwnerId: userId,
      members: { create: { userId, role: 'owner' } },
      auditEvents: { create: { actorId: userId, action: 'workspace.created' } },
    } })
  } catch (error: any) {
    if (error?.code !== 'P2002') throw error
    return db.workspace.findUniqueOrThrow({ where: { personalOwnerId: userId } })
  }
}

export async function createWorkspace(userId: string, name: string) {
  name = workspaceName.parse(name)
  const db = workspaceDb()
  if (!await db.user.findUnique({ where: { id: userId }, select: { id: true } })) throw new WorkspaceError(401, 'Account not found')
  return db.workspace.create({ data: { id: randomUUID(), name,
    members: { create: { userId, role: 'owner' } },
    auditEvents: { create: { actorId: userId, action: 'workspace.created' } },
  } })
}

/** Only existing members can be changed here. Invitation/acceptance is separate. */
export async function changeMembership(actorId: string, workspaceId: string, userId: string, role: 'editor' | 'viewer' | null) {
  z.enum(['editor', 'viewer']).nullable().parse(role)
  await requireMembership(actorId, workspaceId, 'owner')
  return workspaceTransaction(async (tx) => {
    const actor = await tx.workspaceMember.findUnique({ where: { workspaceId_userId: { workspaceId, userId: actorId } } })
    if (actor?.role !== 'owner') throw new WorkspaceError(403, 'Workspace owner required')
    const member = await tx.workspaceMember.findUnique({ where: { workspaceId_userId: { workspaceId, userId } } })
    if (!member) throw new WorkspaceError(404, 'Member not found')
    if (member.role === 'owner') throw new WorkspaceError(409, 'Owner transfer requires a separate workflow')
    if (role === null) await tx.workspaceMember.delete({ where: { workspaceId_userId: { workspaceId, userId } } })
    else await tx.workspaceMember.update({ where: { workspaceId_userId: { workspaceId, userId } }, data: { role } })
    await tx.workspaceAuditEvent.create({ data: { workspaceId, actorId, action: role === null ? 'member.removed' : `member.role.${role}`, resourceId: userId } })
  })
}
