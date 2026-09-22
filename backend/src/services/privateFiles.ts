import { createHash, randomUUID } from 'crypto'
import { constants } from 'fs'
import { prisma } from './prisma'
import { PrivateStorageError, readBoundedFile, withPrivateStorage, writePrivateBytes } from './privateStorage'

export const MAX_FILE_BYTES = 50 * 1024 * 1024
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024
export const FILE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export class FileAccessError extends Error {
  constructor(public readonly status: number, message: string) { super(message) }
}

function database() {
  if (!prisma) throw new FileAccessError(503, 'Private files require a database')
  return prisma
}

export function safeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^\.+/, '').slice(0, 120) || 'file'
}

/** Signature allowlist, not an antivirus or full image-decoding check. */
export function detectImageMime(buffer: Buffer): string | null {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png'
  if (buffer.length >= 3 && buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255) return 'image/jpeg'
  if (buffer.length >= 6 && ['GIF87a', 'GIF89a'].includes(buffer.toString('ascii', 0, 6))) return 'image/gif'
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
  return null
}

export async function requireOwnedConversation(userId: string, conversationId: string) {
  if (!userId || !conversationId) throw new FileAccessError(404, 'Conversation not found')
  const conversation = await database().conversation.findFirst({ where: { id: conversationId, userId }, select: { id: true } })
  if (!conversation) throw new FileAccessError(404, 'Conversation not found')
  return conversation
}

export async function storePrivateFile(input: {
  userId: string; conversationId?: string; name: string; mimeType: string;
  purpose: 'upload' | 'artifact'; buffer: Buffer;
}) {
  const db = database()
  if (!input.userId) throw new FileAccessError(401, 'File owner required')
  if (!input.buffer.length || input.buffer.length > MAX_FILE_BYTES) throw new FileAccessError(413, 'File must contain 1 to 50 MiB of data')
  if (input.conversationId) await requireOwnedConversation(input.userId, input.conversationId)
  const id = randomUUID()
  return withPrivateStorage(async namespace => {
    const owned = await namespace.writeBytes(id, input.buffer)
    try {
      // Keep the original namespace alive through publication and any rollback.
      await namespace.assertCurrent()
      return await db.privateFile.create({ data: {
        id, userId: input.userId, conversationId: input.conversationId,
        name: safeFileName(input.name), mimeType: input.mimeType, size: input.buffer.length,
        sha256: createHash('sha256').update(input.buffer).digest('hex'), purpose: input.purpose,
      } })
    } catch (error) {
      await namespace.unlink(id, owned).catch(() => undefined)
      throw error
    }
  }, { createLocal: true })
}

export interface StagedPrivateArtifact { id: string; name: string; mimeType: string; size: number; sha256: string }

/** Prepare immutable bytes without a PrivateFile row (therefore no public/owner
 * access yet). Each attempt has a fresh UUID: an expired worker cannot overwrite
 * a winner's bytes. A crash before evidence leaves an inaccessible orphan.
 * Production requires an identified shared filesystem; no automatic GC.
 */
export async function stagePrivateArtifact(name: string, mimeType: string, buffer: Buffer): Promise<StagedPrivateArtifact> {
  if (!buffer.length || buffer.length > MAX_FILE_BYTES) throw new FileAccessError(413, 'Invalid artifact size')
  const id = randomUUID()
  await writePrivateBytes(id, buffer)
  return { id, name: safeFileName(name), mimeType, size: buffer.length,
    sha256: createHash('sha256').update(buffer).digest('hex') }
}

/** Recovery verifies prepared bytes before publishing metadata. This returns a
 * snapshot, not a namespace lease: callers must quiesce mount changes across
 * their subsequent DB publication (filesystem and DB commits are not atomic).
 */
export async function verifyStagedArtifact(value: unknown): Promise<StagedPrivateArtifact> {
  const item = value as StagedPrivateArtifact
  if (!item || !FILE_ID.test(item.id) || item.mimeType !== 'video/mp4' ||
      typeof item.name !== 'string' || item.name !== safeFileName(item.name) ||
      !Number.isSafeInteger(item.size) || item.size < 1 || item.size > MAX_FILE_BYTES || !/^[a-f0-9]{64}$/.test(item.sha256)) {
    throw new FileAccessError(409, 'Invalid staged artifact')
  }
  return withPrivateStorage(async namespace => {
    try {
      const stat = await namespace.lstat(item.id)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== item.size) throw new FileAccessError(409, 'Invalid staged artifact')
      const handle = await namespace.open(item.id, constants.O_RDONLY | (constants.O_NONBLOCK || 0))
      try {
        const opened = await handle.stat()
        if (!opened.isFile() || opened.size !== item.size || opened.dev !== stat.dev || opened.ino !== stat.ino) throw new FileAccessError(409, 'Invalid staged artifact')
        const buffer = await readBoundedFile(handle, item.size)
        if (buffer.length !== item.size || createHash('sha256').update(buffer).digest('hex') !== item.sha256) throw new FileAccessError(409, 'Invalid staged artifact')
      } finally { await handle.close() }
      await namespace.assertCurrent()
    } catch (error: any) {
      if (error instanceof FileAccessError) throw error
      if (error?.code === 'ENOENT' || error?.code === 'ELOOP') throw new FileAccessError(409, 'Invalid staged artifact')
      throw new PrivateStorageError()
    }
    return item
  })
}

async function lookupOwnedFile(userId: string, id: string, conversationId?: string) {
  if (!userId || !FILE_ID.test(id)) throw new FileAccessError(404, 'File not found')
  const row = await database().privateFile.findFirst({
    where: { id, userId, deletedAt: null, ...(conversationId ? { conversationId } : {}),
      OR: [{ conversationId: null }, { conversation: { userId } }] },
  })
  if (!row) throw new FileAccessError(404, 'File not found')
  return row
}

export async function findOwnedFile(userId: string, id: string, conversationId?: string) {
  if (!userId || !FILE_ID.test(id)) throw new FileAccessError(404, 'File not found')
  return withPrivateStorage(async namespace => {
    const row = await lookupOwnedFile(userId, id, conversationId)
    await namespace.assertCurrent()
    return row
  })
}

export function fileReference(file: { id: string; name: string; mimeType: string; size: number }) {
  return { id: file.id, name: file.name, mimeType: file.mimeType, size: file.size, url: `/api/files/${file.id}/content` }
}

export async function readOwnedFile(userId: string, id: string, conversationId?: string) {
  if (!userId || !FILE_ID.test(id)) throw new FileAccessError(404, 'File not found')
  return withPrivateStorage(async namespace => {
    const row = await lookupOwnedFile(userId, id, conversationId)
    try {
      const stat = await namespace.lstat(row.id)
      if (!stat.isFile() || stat.isSymbolicLink()) throw new FileAccessError(404, 'File not found')
      const handle = await namespace.open(row.id, constants.O_RDONLY | (constants.O_NONBLOCK || 0))
      let buffer: Buffer
      try {
        const opened = await handle.stat()
        if (!opened.isFile() || opened.size !== row.size || opened.size < 1 || opened.size > MAX_FILE_BYTES ||
            opened.dev !== stat.dev || opened.ino !== stat.ino) throw new FileAccessError(409, 'File integrity check failed')
        buffer = await readBoundedFile(handle, row.size)
        if (buffer.length !== row.size || createHash('sha256').update(buffer).digest('hex') !== row.sha256) {
          throw new FileAccessError(409, 'File integrity check failed')
        }
      } finally { await handle.close() }
      await namespace.assertCurrent()
      return { file: row, buffer }
    } catch (error: any) {
      if (error?.code === 'ENOENT' || error?.code === 'ELOOP') throw new FileAccessError(404, 'File not found')
      if (error instanceof FileAccessError) throw error
      throw new PrivateStorageError()
    }
  })
}

export async function readOwnedImage(userId: string, conversationId: string, id: string) {
  const { file, buffer } = await readOwnedFile(userId, id, conversationId)
  const mime = detectImageMime(buffer)
  if (!mime || mime !== file.mimeType || buffer.length > MAX_IMAGE_BYTES) throw new FileAccessError(415, 'Attachment is not a supported image')
  return { reference: fileReference(file), dataUri: `data:${mime};base64,${buffer.toString('base64')}` }
}

const PUBLISH_TOKEN = /^[a-f0-9]{32}$/

/** Publish a view-only link. Idempotent: re-publishing keeps the same token. */
export async function publishOwnedFile(userId: string, id: string): Promise<{ token: string }> {
  if (!userId || !FILE_ID.test(id)) throw new FileAccessError(404, 'File not found')
  const db = database()
  const row = await db.privateFile.findFirst({ where: { id, userId, deletedAt: null } })
  if (!row) throw new FileAccessError(404, 'File not found')
  const token = row.publishToken || randomUUID().replace(/-/g, '')
  await db.privateFile.update({ where: { id }, data: { publishToken: token, publishedAt: row.publishedAt || new Date() } })
  return { token }
}

export async function unpublishOwnedFile(userId: string, id: string): Promise<void> {
  if (!userId || !FILE_ID.test(id)) throw new FileAccessError(404, 'File not found')
  const db = database()
  const row = await db.privateFile.findFirst({ where: { id, userId } })
  if (!row) throw new FileAccessError(404, 'File not found')
  await db.privateFile.update({ where: { id }, data: { publishToken: null, publishedAt: null } })
}

/** Anonymous read of a published file by its token. */
export async function readPublishedFile(token: string) {
  if (!PUBLISH_TOKEN.test(token)) throw new FileAccessError(404, 'File not found')
  const row = await database().privateFile.findFirst({ where: { publishToken: token, deletedAt: null } })
  if (!row) throw new FileAccessError(404, 'File not found')
  return withPrivateStorage(async namespace => {
    try {
      const handle = await namespace.open(row.id, constants.O_RDONLY | (constants.O_NONBLOCK || 0))
      try {
        const buffer = await readBoundedFile(handle, row.size)
        if (buffer.length !== row.size || createHash('sha256').update(buffer).digest('hex') !== row.sha256) {
          throw new FileAccessError(409, 'File integrity check failed')
        }
        return { file: row, buffer }
      } finally { await handle.close() }
    } catch (error: any) {
      if (error?.code === 'ENOENT' || error?.code === 'ELOOP') throw new FileAccessError(404, 'File not found')
      if (error instanceof FileAccessError) throw error
      throw new PrivateStorageError()
    }
  })
}

export async function deleteOwnedFile(userId: string, id: string) {
  if (!userId || !FILE_ID.test(id)) throw new FileAccessError(404, 'File not found')
  return withPrivateStorage(async namespace => {
    const db = database()
    const row = await db.privateFile.findFirst({ where: { id, userId } })
    if (!row) throw new FileAccessError(404, 'File not found')
    await namespace.assertCurrent()
    // Revoke access first. A namespace change across the DB await leaves an
    // inaccessible orphan for retry when the original namespace is restored;
    // never unlink in a replacement root during this operation.
    await db.privateFile.updateMany({ where: { id, userId, deletedAt: null }, data: { deletedAt: new Date() } })
    await namespace.unlink(id).catch((error) => {
      if (error?.code !== 'ENOENT') throw new PrivateStorageError()
    })
  })
}
