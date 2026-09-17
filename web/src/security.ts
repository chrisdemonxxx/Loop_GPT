export class ClientError extends Error {
  constructor(public readonly code: 'network' | 'protocol' | 'tooLarge' | 'config' | 'http', public readonly status?: number) {
    super(code)
  }
}

// Configuration is build-time operator input, never a query parameter or model URL.
export function apiOrigin(raw: string): string {
  if (!raw.trim()) return ''
  let url: URL
  try { url = new URL(raw) } catch { throw new ClientError('config') }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
      url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new ClientError('config')
  }
  return url.origin
}

export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ClientError('protocol')
  return value as Record<string, unknown>
}

export function text(value: unknown, max = 1_000_000): string {
  if (typeof value !== 'string' || value.length > max) throw new ClientError('protocol')
  return value
}

export function resourceId(value: unknown): string {
  const id = text(value, 160)
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new ClientError('protocol')
  return id
}

export function filePath(id: string): string {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id)) throw new ClientError('protocol')
  return `/api/files/${id}/content`
}

export function safeFilename(name: string): string {
  const cleaned = name.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069/\\:*?"<>|]/g, '_')
    .replace(/^\.+/, '').replace(/[. ]+$/, '').slice(0, 120)
  return cleaned || 'download'
}

export async function readBounded(response: Response, max: number): Promise<Uint8Array> {
  if (!response.body) throw new ClientError('protocol')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const result = await reader.read()
      if (result.done) break
      size += result.value.byteLength
      if (size > max) throw new ClientError('tooLarge')
      chunks.push(result.value)
    }
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
    return bytes
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
