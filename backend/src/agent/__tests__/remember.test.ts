import { beforeEach, describe, expect, it, vi } from 'vitest'

const db = vi.hoisted(() => ({
  create: vi.fn(),
  findUnique: vi.fn(),
}))

vi.mock('../../services/prisma', () => ({
  prisma: {
    memory: { create: db.create },
    conversation: { findUnique: db.findUnique },
  },
}))

import { rememberTool } from '../tools/remember'

const ctx = {
  userId: 'user-1',
  conversationId: 'conv-1',
  workspaceId: 'workspace-not-a-project',
  emit: () => undefined,
  scratch: {},
}

beforeEach(() => {
  db.create.mockReset().mockResolvedValue({ id: 'mem-1' })
  db.findUnique.mockReset()
})

describe('remember tool', () => {
  it('stores the conversation project id, not the workspace id', async () => {
    db.findUnique.mockResolvedValue({ projectId: 'project-1' })
    const result = await rememberTool.handler({ fact: 'Prefers dark mode' }, ctx as any)
    expect(result.isError).toBeUndefined()
    expect(db.findUnique).toHaveBeenCalledWith({ where: { id: 'conv-1' }, select: { projectId: true } })
    expect(db.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: 'user-1',
        content: 'Prefers dark mode',
        projectId: 'project-1',
      }),
    })
    expect(db.create.mock.calls[0][0].data.projectId).not.toBe('workspace-not-a-project')
  })

  it('omits projectId when the conversation is not in a project', async () => {
    db.findUnique.mockResolvedValue({ projectId: null })
    await rememberTool.handler({ fact: 'Lives in Lisbon' }, ctx as any)
    expect(db.create.mock.calls[0][0].data.projectId).toBeUndefined()
  })
})
