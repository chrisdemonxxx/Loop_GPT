'use client'

import { useEffect, useState } from 'react'
import { API_URL, authHeaders } from '../../lib/api'
import { type ArtifactRef } from '../../lib/stream'

/** Resolve a private attachment to a local object URL via the authenticated
 * content endpoint. The retired public /uploads path is never used. */
export function useAttachmentUrl(attachmentId?: string): string | null {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    let objectUrl: string | null = null
    let revoked = false
    if (!attachmentId) { setUrl(null); return }
    ;(async () => {
      try {
        const res = await fetch(`${API_URL}/api/files/${attachmentId}/content`, { headers: authHeaders(false) })
        if (!res.ok) return
        const blob = await res.blob()
        if (revoked) return
        objectUrl = URL.createObjectURL(blob)
        setUrl(objectUrl)
      } catch { /* offline or expired: leave the placeholder */ }
    })()
    return () => { revoked = true; if (objectUrl) URL.revokeObjectURL(objectUrl) }
  }, [attachmentId])
  return url
}

/** Authed artifact URL → object URL. Artifact refs point at the auth-only
 * content endpoint; a raw <img src>/href would 401 (the reported bug).
 * Same proven pattern as useAttachmentUrl, for any authed href. */
export function useAuthedUrl(href: string | undefined): string | null {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    let objectUrl: string | null = null
    let revoked = false
    if (!href || href.startsWith('blob:')) { setUrl(href ?? null); return }
    if (!href.startsWith(`${API_URL}/api/files/`) && !href.startsWith('/api/files/')) { setUrl(href); return }
    ;(async () => {
      try {
        const res = await fetch(href.startsWith('http') ? href : `${API_URL}${href}`, { headers: authHeaders(false) })
        if (!res.ok) return
        const blob = await res.blob()
        if (revoked) return
        objectUrl = URL.createObjectURL(blob)
        setUrl(objectUrl)
      } catch { /* leave the fallback affordance */ }
    })()
    return () => { revoked = true; if (objectUrl) URL.revokeObjectURL(objectUrl) }
  }, [href])
  return url
}

/** Authed download: fetch with the session token, then hand the browser a
 * correctly named, correct-MIME file. Never a raw href on auth-only URLs. */
export async function downloadArtifact(a: ArtifactRef, href?: string | null) {
  if (!href) return
  try {
    const res = await fetch(href.startsWith('http') ? href : `${API_URL}${href}`, { headers: authHeaders(false) })
    if (!res.ok) return
    const blob = await res.blob()
    const objectUrl = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = objectUrl
    link.download = a.name || 'artifact'
    document.body.appendChild(link)
    link.click()
    link.remove()
    URL.revokeObjectURL(objectUrl)
  } catch { /* offline or expired */ }
}

export function isVideoArtifact(a: ArtifactRef) {
  return a.kind === 'video' || (a.mimeType || '').startsWith('video/') || /\.(mp4|webm|mov)$/i.test(a.name)
}

/** Normalize an artifact href relative to the API origin. */
export function artifactHref(url?: string): string | undefined {
  return url ? (url.startsWith('http') ? url : `${API_URL}${url}`) : undefined
}

/** Extract the private-file id from an artifact href (for signed links). */
export function artifactFileId(a: ArtifactRef): string | null {
  const m = (a.url || '').match(/\/api\/files\/([^/]+)\//)
  return m ? m[1] : null
}

/** Fetch authed text content (code/markdown/csv) for in-panel viewers. */
export function useAuthedText(href: string | undefined): { text: string | null; loading: boolean } {
  const [text, setText] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  useEffect(() => {
    if (!href) { setText(null); return }
    let cancelled = false
    setLoading(true)
    fetch(href, { headers: authHeaders(false) })
      .then((r) => (r.ok ? r.text() : null))
      .then((t) => { if (!cancelled) { setText(t); setLoading(false) } })
      .catch(() => { if (!cancelled) { setText(null); setLoading(false) } })
    return () => { cancelled = true }
  }, [href])
  return { text, loading }
}

/** Mint a short-lived signed link and open the private artifact in a new
 * tab (the tab carries no session — the signature is the credential). */
export async function openArtifactInNewTab(a: ArtifactRef): Promise<void> {
  const id = artifactFileId(a)
  if (!id) {
    const href = artifactHref(a.url)
    if (href) window.open(href, '_blank', 'noopener')
    return
  }
  try {
    const res = await fetch(`${API_URL}/api/files/${id}/signed-link`, { method: 'POST', headers: authHeaders() })
    if (!res.ok) throw new Error('link')
    const { url } = await res.json()
    window.open(url.startsWith('http') ? url : `${API_URL}${url}`, '_blank', 'noopener')
  } catch { /* leave the artifact in place */ }
}
