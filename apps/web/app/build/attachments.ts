/**
 * Image paste/drop for Build composers (Phase 1.15).
 * Uploads via PrivateFile (conversation upload-image), mints a signed URL,
 * and returns that URL for the run's attachment_urls. Vision routing is deferred.
 */

import { API_URL, authHeaders } from '../lib/api'

export type BuildAttachment = {
  id: string
  name: string
  previewUrl?: string
  status: 'uploading' | 'done' | 'error'
  url?: string
  error?: string
}

const MAX = 4

/** Absolute URL the builder can fetch. An empty API base uses this page's origin. */
export function absoluteAttachmentUrl(
  path: string,
  apiUrl = API_URL,
  origin = typeof window !== 'undefined' ? window.location.origin : '',
): string {
  if (/^https?:\/\//i.test(path)) return path
  const base = (apiUrl || origin).replace(/\/$/, '')
  const suffix = path.startsWith('/') ? path : `/${path}`
  return `${base}${suffix}`
}

export function isImageFile(file: File): boolean {
  return file.type.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp)$/i.test(file.name)
}

export async function uploadBuildImage(file: File): Promise<{ attachmentId: string; url: string }> {
  const fd = new FormData()
  fd.append('image', file)
  const uploadRes = await fetch(`${API_URL}/api/conversations/new/upload-image`, {
    method: 'POST',
    headers: authHeaders(false),
    body: fd,
  })
  const uploadBody = await uploadRes.json().catch(() => ({})) as {
    attachmentId?: string
    error?: string
  }
  if (!uploadRes.ok || !uploadBody.attachmentId) {
    throw new Error(uploadBody.error || 'Image upload failed')
  }
  const linkRes = await fetch(`${API_URL}/api/files/${uploadBody.attachmentId}/signed-link`, {
    method: 'POST',
    headers: authHeaders(),
  })
  const linkBody = await linkRes.json().catch(() => ({})) as { url?: string; error?: string }
  if (!linkRes.ok || !linkBody.url) {
    // Fall back to authenticated content path so the run still receives a reference.
    return {
      attachmentId: uploadBody.attachmentId,
      url: absoluteAttachmentUrl(`/api/files/${uploadBody.attachmentId}/content`),
    }
  }
  return { attachmentId: uploadBody.attachmentId, url: absoluteAttachmentUrl(linkBody.url) }
}

export function collectImageFiles(from: DataTransfer | FileList | null | undefined): File[] {
  if (!from) return []
  const list = 'length' in from && !(from instanceof DataTransfer)
    ? Array.from(from as FileList)
    : Array.from((from as DataTransfer).files ?? [])
  return list.filter(isImageFile).slice(0, MAX)
}

export function readPreview(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onloadend = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}
