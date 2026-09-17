import express from 'express'
import multer from 'multer'
import { authenticateToken } from './auth'
import { authenticateApiKey, type ApiRequest } from '../middleware/apiAuth'
import { prisma } from '../services/prisma'
import { getOrCreateConversation } from '../services/chatStore'
import {
  MAX_IMAGE_BYTES, FileAccessError, detectImageMime, requireOwnedConversation,
  storePrivateFile, readOwnedFile, findOwnedFile, deleteOwnedFile, fileReference,
} from '../services/privateFiles'

export function fileErrorResponse(error: unknown, res: express.Response) {
  if (error instanceof FileAccessError) return res.status(error.status).json({ error: error.message })
  if (error instanceof multer.MulterError) return res.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: 'Invalid or oversized image upload' })
  // Do not expose paths, database errors, or credentials to the client.
  return res.status(503).json({ error: 'File storage is temporarily unavailable' })
}

/** Downloads work with a user JWT or that user's developer key, never a query token. */
async function authenticateFileRequest(req: ApiRequest, res: express.Response, next: express.NextFunction) {
  if (req.headers.authorization?.startsWith('Bearer sk-loop-')) {
    try {
      await authenticateApiKey(req, res, error => {
        if (error) return next(error)
        ;(req as any).userId = req.api!.userId
        next()
      })
    } catch (error) { fileErrorResponse(error, res) }
  } else authenticateToken(req, res, next)
}

export const filesRouter = express.Router()
filesRouter.use(authenticateFileRequest)
filesRouter.get('/:id', async (req, res) => {
  try { res.json(fileReference(await findOwnedFile((req as any).userId, req.params.id))) }
  catch (error) { fileErrorResponse(error, res) }
})
filesRouter.get('/:id/content', async (req, res) => {
  try {
    const { file, buffer } = await readOwnedFile((req as any).userId, req.params.id)
    res.setHeader('Cache-Control', 'private, no-store')
    res.vary('Authorization')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'")
    res.setHeader('Content-Disposition', `attachment; filename="${file.name}"`)
    res.setHeader('Content-Type', file.mimeType)
    res.send(buffer)
  } catch (error) { fileErrorResponse(error, res) }
})
filesRouter.delete('/:id', async (req, res) => {
  try { await deleteOwnedFile((req as any).userId, req.params.id); res.status(204).end() }
  catch (error) { fileErrorResponse(error, res) }
})

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_IMAGE_BYTES, files: 1, fields: 0, parts: 1 } })
export const imageUploadRouter = express.Router()
imageUploadRouter.post('/:conversationId/upload-image', authenticateToken, async (req, res) => {
  try {
    if (!prisma) throw new FileAccessError(503, 'Private files require a database')
    if (req.params.conversationId !== 'new') await requireOwnedConversation((req as any).userId, req.params.conversationId)
  } catch (error) { fileErrorResponse(error, res); return }

  upload.single('image')(req, res, async (error) => {
    if (error) { fileErrorResponse(error, res); return }
    try {
      if (!req.file) throw new FileAccessError(400, 'No image file uploaded')
      const mimeType = detectImageMime(req.file.buffer)
      if (!mimeType || mimeType !== req.file.mimetype) throw new FileAccessError(415, 'Image signature and declared type must match')
      const conversation = await getOrCreateConversation((req as any).userId, req.params.conversationId, 'Image Chat')
      if (!conversation) throw new FileAccessError(404, 'Conversation not found')
      const file = await storePrivateFile({ userId: (req as any).userId, conversationId: conversation.id,
        name: req.file.originalname, mimeType, purpose: 'upload', buffer: req.file.buffer })
      res.status(201).json({ success: true, attachmentId: file.id, conversationId: conversation.id, ...fileReference(file) })
    } catch (failure) { fileErrorResponse(failure, res) }
  })
})

export const rejectLegacyUploads: express.RequestHandler = (_req, res) => {
  res.status(410).setHeader('Cache-Control', 'no-store')
  res.json({ error: 'Public uploads have been retired. Use authenticated file endpoints.' })
}
