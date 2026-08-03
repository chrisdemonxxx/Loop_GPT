/**
 * Minimal fetch-based HTTP helpers.
 *
 * We use the global fetch (undici) rather than axios for outbound calls in
 * tools because fetch honors HTTPS proxies via CONNECT tunneling, which some
 * managed/sandboxed environments require. Timeouts use AbortController.
 */
export interface HttpOptions {
  headers?: Record<string, string>
  timeoutMs?: number
  signal?: AbortSignal
}

function withTimeout(timeoutMs: number, external?: AbortSignal): { signal: AbortSignal; cancel: () => void } {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  if (external) {
    if (external.aborted) ctrl.abort()
    else external.addEventListener('abort', () => ctrl.abort(), { once: true })
  }
  return { signal: ctrl.signal, cancel: () => clearTimeout(timer) }
}

export async function fetchText(url: string, opts: HttpOptions = {}): Promise<string> {
  const { signal, cancel } = withTimeout(opts.timeoutMs ?? 20000, opts.signal)
  try {
    const res = await fetch(url, { headers: opts.headers, signal })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.text()
  } finally {
    cancel()
  }
}

export async function postForm(url: string, form: Record<string, string>, opts: HttpOptions = {}): Promise<string> {
  const { signal, cancel } = withTimeout(opts.timeoutMs ?? 20000, opts.signal)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(opts.headers || {}) },
      body: new URLSearchParams(form).toString(),
      signal,
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.text()
  } finally {
    cancel()
  }
}

export async function postJson<T = any>(url: string, body: any, opts: HttpOptions = {}): Promise<T> {
  const { signal, cancel } = withTimeout(opts.timeoutMs ?? 20000, opts.signal)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
      body: JSON.stringify(body),
      signal,
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`)
    return (await res.json()) as T
  } finally {
    cancel()
  }
}

export async function getJson<T = any>(url: string, opts: HttpOptions = {}): Promise<T> {
  const { signal, cancel } = withTimeout(opts.timeoutMs ?? 20000, opts.signal)
  try {
    const res = await fetch(url, { headers: opts.headers, signal })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return (await res.json()) as T
  } finally {
    cancel()
  }
}

export async function fetchBuffer(url: string, opts: HttpOptions & { method?: string; body?: any } = {}): Promise<Buffer> {
  const { signal, cancel } = withTimeout(opts.timeoutMs ?? 120000, opts.signal)
  try {
    const res = await fetch(url, {
      method: opts.method || 'GET',
      headers: opts.headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      signal,
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`)
    const ab = await res.arrayBuffer()
    return Buffer.from(ab)
  } finally {
    cancel()
  }
}
