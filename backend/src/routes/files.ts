import express from 'express'
import multer from 'multer'
import { authenticateToken } from './auth'
import { authenticateApiKey, type ApiRequest } from '../middleware/apiAuth'
import { prisma } from '../services/prisma'
import { getOrCreateConversation } from '../services/chatStore'
import {
  MAX_IMAGE_BYTES, FileAccessError, detectImageMime, requireOwnedConversation,
  storePrivateFile, readOwnedFile, findOwnedFile, deleteOwnedFile, fileReference,
  publishOwnedFile, unpublishOwnedFile, readPublishedFile,
  sendFileResponse,
} from '../services/privateFiles'
import { extractDocumentText, MAX_DOC_BYTES } from '../services/documentText'
import { createFileLink, verifyFileLink } from '../services/signedFileUrl'

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

/**
 * File content. Two accepted credentials:
 *  - Authorization header (JWT or developer key) — the in-app path.
 *  - A short-lived signed link (?p=&s=) minted by POST /:id/signed-link —
 *    the "Open in new tab" path for private (non-published) artifacts. The
 *    MAC binds owner + file + expiry; signed reads render inline (sandboxed
 *    by CSP) instead of downloading.
 *
 * Registered BEFORE the router-wide auth guard so the signed path works
 * without a session; every read is still ownership-scoped.
 */
filesRouter.get('/:id/content', async (req, res, next) => {
  try {
    const payload = String(req.query.p || '')
    const sig = String(req.query.s || '')
    const signed = payload && sig ? verifyFileLink(payload, sig, req.params.id) : null
    let userId: string
    if (signed) {
      userId = signed.ownerId
    } else {
      const authorized = await new Promise<boolean>((resolve) => {
        let settled = false
        // The auth middleware either calls next() (accept), calls next(err)
        // (contained failure — forwarded to the error chain exactly as the
        // pre-restructure router.use flow did), or writes an error response
        // without calling next (reject — settle on 'finish').
        res.on('finish', () => { if (!settled) { settled = true; resolve(false) } })
        authenticateFileRequest(req as ApiRequest, res, (err?: any) => {
          if (!settled) { settled = true; resolve(!err) }
          if (err) next(err)
        })
      })
      if (!authorized) return // a response (or error-chain 500) has been sent
      userId = (req as any).userId
    }
    const { file, buffer } = await readOwnedFile(userId, req.params.id)
    res.setHeader('Cache-Control', 'private, no-store')
    res.vary('Authorization')
    // Byte-range aware send (audit P3): Accept-Ranges on the first response,
    // 206/Content-Range for Range requests — native <video> streaming over
    // both credential paths (session header and signed link).
    sendFileResponse(res, file, buffer, signed
      ? {
          inline: true,
          csp: "sandbox allow-scripts allow-forms; default-src 'none'; img-src data: blob:; media-src data: blob:; style-src 'unsafe-inline'; script-src 'unsafe-inline'",
        }
      : { inline: false, csp: 'sandbox; default-src \'none\'' })
  } catch (error) { fileErrorResponse(error, res) }
})

filesRouter.use(authenticateFileRequest)
filesRouter.get('/:id', async (req, res) => {
  try { res.json(fileReference(await findOwnedFile((req as any).userId, req.params.id))) }
  catch (error) { fileErrorResponse(error, res) }
})
filesRouter.delete('/:id', async (req, res) => {
  try { await deleteOwnedFile((req as any).userId, req.params.id); res.status(204).end() }
  catch (error) { fileErrorResponse(error, res) }
})
/** Mint a short-lived signed link for opening a private artifact in a new
 * tab (the new tab carries no session). Ownership-checked before signing. */
filesRouter.post('/:id/signed-link', async (req, res) => {
  try {
    await findOwnedFile((req as any).userId, req.params.id)
    const link = createFileLink((req as any).userId, req.params.id)
    res.json({ url: link.url, expiresIn: link.expiresIn })
  } catch (error) { fileErrorResponse(error, res) }
})

/** Publish a view-only public link. */
filesRouter.post('/:id/publish', async (req, res) => {
  try {
    const { token } = await publishOwnedFile((req as any).userId, req.params.id)
    res.json({ token, url: `/api/files/public/${token}/content` })
  } catch (error) { fileErrorResponse(error, res) }
})
filesRouter.delete('/:id/publish', async (req, res) => {
  try { await unpublishOwnedFile((req as any).userId, req.params.id); res.status(204).end() }
  catch (error) { fileErrorResponse(error, res) }
})

/** Anonymous read-only download of a published file. Range-aware so shared
 * videos stream/seek in the browser player. */
export const publicFilesRouter = express.Router()
publicFilesRouter.get('/public/:token/content', async (req, res) => {
  try {
    const { file, buffer } = await readPublishedFile(req.params.token)
    res.setHeader('Cache-Control', 'public, max-age=300')
    sendFileResponse(res, file, buffer, { inline: true, csp: "sandbox; default-src 'none'" })
  } catch (error) { fileErrorResponse(error, res) }
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
    } catch (failure) { fileErrorResponse(error ?? failure, res) }
  })
})

/** Document (PDF/DOCX/XLSX/CSV/TXT/MD) chat attachment: the ORIGINAL file is
 * stored, and the extracted text is stored as a companion `.extracted.txt`
 * PrivateFile whose id is what the stream inlines into the prompt. */
const docUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_DOC_BYTES, files: 1, fields: 0, parts: 1 } })
imageUploadRouter.post('/:conversationId/upload-document', authenticateToken, async (req, res) => {
  try {
    if (!prisma) throw new FileAccessError(503, 'Private files require a database')
    if (req.params.conversationId !== 'new') await requireOwnedConversation((req as any).userId, req.params.conversationId)
  } catch (error) { fileErrorResponse(error, res); return }

  docUpload.single('document')(req, res, async (error) => {
    if (error) { fileErrorResponse(error, res); return }
    try {
      if (!req.file) throw new FileAccessError(400, 'No document file uploaded')
      const extracted = await extractDocumentText(req.file.buffer, req.file.originalname)
      if (extracted.chars < 40) throw new FileAccessError(422, 'No extractable text found in this document (scanned PDFs without a text layer are not supported yet — paste the text instead).')
      const conversation = await getOrCreateConversation((req as any).userId, req.params.conversationId, 'Document Chat')
      if (!conversation) throw new FileAccessError(404, 'Conversation not found')
      // Keep the original for download/history.
      await storePrivateFile({ userId: (req as any).userId, conversationId: conversation.id,
        name: req.file.originalname, mimeType: 'application/octet-stream', purpose: 'upload', buffer: req.file.buffer })
      // The text companion is the attachment the stream inlines.
      const textFile = await storePrivateFile({ userId: (req as any).userId, conversationId: conversation.id,
        name: `${req.file.originalname}.extracted.txt`, mimeType: 'text/plain', purpose: 'upload',
        buffer: Buffer.from(extracted.text, 'utf8') })
      res.status(201).json({ success: true, attachmentId: textFile.id, conversationId: conversation.id,
        kind: extracted.kind, chars: extracted.chars, truncated: extracted.truncated, ...fileReference(textFile) })
    } catch (failure) { fileErrorResponse(failure, res) }
  })
})

export const rejectLegacyUploads: express.RequestHandler = (_req, res) => {
  res.status(410).setHeader('Cache-Control', 'no-store')
  res.json({ error: 'Public uploads have been retired. Use authenticated file endpoints.' })
}
