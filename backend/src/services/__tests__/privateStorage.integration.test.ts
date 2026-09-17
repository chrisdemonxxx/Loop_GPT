import { randomUUID } from 'crypto'
import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { prisma } from '../prisma'
import { deleteOwnedFile, readOwnedFile, stagePrivateArtifact, storePrivateFile, verifyStagedArtifact } from '../privateFiles'
import { initializePrivateStorage } from '../privateStorage'

const db = prisma!, owner = `private-storage-${randomUUID()}`
let root: string, storeId: string
const bytes = Buffer.from('production private-filesystem persistence fixture')
beforeAll(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'loop-storage-pg-')))
  storeId = randomUUID()
  vi.stubEnv('NODE_ENV', 'production'); vi.stubEnv('PRIVATE_FILES_DIR', root)
  vi.stubEnv('PRIVATE_FILES_STORAGE_MODE', 'shared-filesystem'); vi.stubEnv('PRIVATE_FILES_STORE_ID', storeId)
  vi.stubEnv('PRIVATE_FILES_MIN_FREE_BYTES', '67108864')
  await initializePrivateStorage()
  await db.user.create({ data: { id: owner, email: `${owner}@example.test`, password: 'fixture-only', name: 'Storage test' } })
})
afterAll(async () => {
  try { await db.user.deleteMany({ where: { id: owner } }); if (root) await fs.rm(root, { recursive: true, force: true }) }
  finally { vi.unstubAllEnvs(); await db.$disconnect() }
})
const store = () => storePrivateFile({ userId: owner, name: 'fixture.bin', mimeType: 'application/octet-stream', purpose: 'artifact', buffer: bytes })

describe('identified production filesystem with PostgreSQL metadata', () => {
  it('persists identity, fails closed on namespace changes, and leaves metadata/data intact', async () => {
    const file = await store()
    expect((await readOwnedFile(owner, file.id)).buffer).toEqual(bytes)
    vi.stubEnv('PRIVATE_FILES_STORE_ID', randomUUID())
    try {
      await expect(readOwnedFile(owner, file.id)).rejects.toMatchObject({ status: 503 })
      await expect(deleteOwnedFile(owner, file.id)).rejects.toMatchObject({ status: 503 })
      await expect(store()).rejects.toMatchObject({ status: 503 })
      expect(await db.privateFile.count({ where: { userId: owner } })).toBe(1)
      expect((await db.privateFile.findUniqueOrThrow({ where: { id: file.id } })).deletedAt).toBeNull()
      expect(await fs.readFile(path.join(root, file.id))).toEqual(bytes)
    } finally { vi.stubEnv('PRIVATE_FILES_STORE_ID', storeId) }
    await deleteOwnedFile(owner, file.id)
    await expect(readOwnedFile(owner, file.id)).rejects.toMatchObject({ status: 404 })
  })
  it('re-verifies persisted staged evidence before publishing private metadata', async () => {
    const staged = await stagePrivateArtifact('prepared.mp4', 'video/mp4', bytes)
    const persisted = JSON.parse(JSON.stringify(staged))
    expect(await db.privateFile.findUnique({ where: { id: staged.id } })).toBeNull()
    const verified = await verifyStagedArtifact(persisted)
    await db.privateFile.create({ data: { ...verified, userId: owner, purpose: 'artifact' } })
    expect((await readOwnedFile(owner, staged.id)).buffer).toEqual(bytes)
    await fs.writeFile(path.join(root, staged.id), Buffer.alloc(bytes.length))
    await expect(verifyStagedArtifact(persisted)).rejects.toMatchObject({ status: 409 })
    await expect(readOwnedFile(owner, staged.id)).rejects.toMatchObject({ status: 409 })
  })
  it('headroom failures cannot persist a file row or staged bytes', async () => {
    const before = await fs.readdir(root), count = await db.privateFile.count({ where: { userId: owner } })
    vi.stubEnv('PRIVATE_FILES_MIN_FREE_BYTES', String(Number.MAX_SAFE_INTEGER))
    try {
      await expect(store()).rejects.toMatchObject({ status: 503 })
      await expect(stagePrivateArtifact('blocked.mp4', 'video/mp4', bytes)).rejects.toMatchObject({ status: 503 })
      expect(await fs.readdir(root)).toEqual(before)
      expect(await db.privateFile.count({ where: { userId: owner } })).toBe(count)
    } finally { vi.stubEnv('PRIVATE_FILES_MIN_FREE_BYTES', '67108864') }
  })
})
