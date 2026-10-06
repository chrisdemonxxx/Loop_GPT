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
export async function downloadArtifact(a: ArtifactRef, href?: string | null): Promise<boolean> {
  if (!href) return false
  try {
    const res = await fetch(href.startsWith('http') ? href : `${API_URL}${href}`, { headers: authHeaders(false) })
    if (!res.ok) return false
    const blob = await res.blob()
    const objectUrl = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = objectUrl
    link.download = a.name || 'artifact'
    document.body.appendChild(link)
    link.click()
    link.remove()
    URL.revokeObjectURL(objectUrl)
    return true
  } catch { return false }
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
export function useAuthedText(href: string | undefined): { text: string | null; loading: boolean; error: boolean; retry: () => void } {
  const [text, setText] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(false)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (!href) { setText(null); setLoading(false); setError(false); return }
    let cancelled = false
    setLoading(true)
    setError(false)
    setText(null)
    fetch(href, { headers: authHeaders(false) })
      .then((r) => { if (!r.ok) throw new Error('open'); return r.text() })
      .then((t) => { if (!cancelled) { setText(t); setLoading(false) } })
      .catch(() => { if (!cancelled) { setText(null); setError(true); setLoading(false) } })
    return () => { cancelled = true }
  }, [href, attempt])
  return { text, loading, error, retry: () => setAttempt((n) => n + 1) }
}

/** Same authed blob fetch as useAuthedUrl, plus a settled error and retry.
 * Cards keep useAuthedUrl; the panel uses this so a failed open is not a shimmer. */
export function useAuthedBlob(href: string | undefined): { url: string | null; loading: boolean; error: boolean; retry: () => void } {
  const [url, setUrl] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(false)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let objectUrl: string | null = null
    let revoked = false
    if (!href || href.startsWith('blob:')) { setUrl(href ?? null); setLoading(false); setError(false); return }
    if (!href.startsWith(`${API_URL}/api/files/`) && !href.startsWith('/api/files/')) { setUrl(href); setLoading(false); setError(false); return }
    setLoading(true)
    setError(false)
    ;(async () => {
      try {
        const res = await fetch(href.startsWith('http') ? href : `${API_URL}${href}`, { headers: authHeaders(false) })
        if (!res.ok) throw new Error('open')
        const blob = await res.blob()
        if (revoked) return
        objectUrl = URL.createObjectURL(blob)
        setUrl(objectUrl)
        setLoading(false)
      } catch {
        if (!revoked) { setUrl(null); setError(true); setLoading(false) }
      }
    })()
    return () => { revoked = true; if (objectUrl) URL.revokeObjectURL(objectUrl) }
  }, [href, attempt])
  return { url, loading, error, retry: () => setAttempt((n) => n + 1) }
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

/**
 * A same-origin, short-lived signed URL for a private artifact (audit P3).
 * Unlike the blob hooks (which download the whole file), a signed URL lets
 * the native media element issue real HTTP byte-range requests — video
 * starts playing immediately and seeking streams only the needed slices.
 * `retry` re-mints (e.g. when a long session outlives the link's TTL).
 */
export function useSignedArtifactUrl(a?: ArtifactRef): { url: string | null; retry: () => void } {
  const [url, setUrl] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    const id = a ? artifactFileId(a) : null
    if (!a || !id) { setUrl(null); return }
    let cancelled = false
    fetch(`${API_URL}/api/files/${id}/signed-link`, { method: 'POST', headers: authHeaders() })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { url?: string } | null) => {
        if (!cancelled && d?.url) setUrl(d.url.startsWith('http') ? d.url : `${API_URL}${d.url}`)
      })
      .catch(() => { /* stays null; the caller shows its fallback */ })
    return () => { cancelled = true }
  }, [a?.id, a?.url, attempt])
  return { url, retry: () => { setUrl(null); setAttempt((n) => n + 1) } }
}
