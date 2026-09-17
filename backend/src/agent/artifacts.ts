/**
 * All generated artifacts have an owner and authenticated content endpoint.
 */
import { storePrivateFile, fileReference } from '../services/privateFiles'
import type { ArtifactRef } from './types'

const EXT_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  csv: 'text/csv',
  md: 'text/markdown',
  txt: 'text/plain',
  json: 'application/json',
  html: 'text/html',
  mp4: 'video/mp4',
  webm: 'video/webm',
}

const EXT_KIND: Record<string, ArtifactRef['kind']> = {
  png: 'image', jpg: 'image', jpeg: 'image', webp: 'image',
  pdf: 'pdf', docx: 'docx', xlsx: 'xlsx', pptx: 'pptx', csv: 'csv',
}

function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80) || 'file'
}

/** Persist bytes privately. Callers must provide a real owner. */
export async function saveArtifact(filename: string, buffer: Buffer, owner: { userId: string; conversationId?: string }): Promise<ArtifactRef> {
  const safe = sanitize(filename)
  const ext = (safe.split('.').pop() || 'bin').toLowerCase()
  const file = await storePrivateFile({ ...owner, name: safe, buffer, mimeType: EXT_MIME[ext] || 'application/octet-stream', purpose: 'artifact' })
  return {
    ...fileReference(file),
    kind: EXT_KIND[ext] || 'file',
  }
}
