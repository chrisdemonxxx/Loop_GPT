import { Readable } from 'stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  HfSandboxError,
  SANDBOX_SERVER_SHA256,
  buildSandboxJobSpec,
  createSandbox,
  deriveSandboxToken,
  execInSandbox,
  findServerUrl,
  killSandbox,
  resetHfSandboxCache,
  type FetchLike,
} from '../../services/hfSandbox'
import { sandboxProviderEnv } from '../../agent/tools/executeCode'

// ── Fake transport ──────────────────────────────────────────────────────────

interface RecordedCall { url: string; init: any }

function fakeResponse(status: number, body: any, stream?: Readable) {
  return {
    status,
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    body: stream ?? null,
  }
}

function makeFetch(routes: Array<{ match: (url: string, init: any) => boolean; respond: (url: string, init: any) => any }>) {
  const calls: RecordedCall[] = []
  const fetchImpl: FetchLike = async (url, init = {}) => {
    calls.push({ url, init })
    for (const route of routes) {
      if (route.match(url, init)) return route.respond(url, init)
    }
    throw new TypeError(`no route for ${url}`)
  }
  return { calls, fetchImpl }
}

const depsOf = (fetchImpl: FetchLike) => ({ fetchImpl, namespace: 'test-ns', sleep: async () => {} })

const JOB = {
  id: 'job123',
  owner: { id: 'u1', name: 'test-ns', type: 'user' },
  status: { stage: 'RUNNING', message: null, exposeUrls: ['https://job123--49983.hf.jobs'] },
}

afterEach(() => {
  vi.unstubAllEnvs()
  resetHfSandboxCache()
})

// ── Pure builders ───────────────────────────────────────────────────────────

describe('deriveSandboxToken', () => {
  it('derives HMAC-SHA256(hfToken, "hf-sandbox:" + nonce) as hex', () => {
    // Independently recomputed: crypto.createHmac('sha256','tok').update('hf-sandbox:abc').digest('hex')
    expect(deriveSandboxToken('tok', 'abc')).toBe('fcad94956ec883e95133c4bf4e69987ab9e6869dc27afd27552df7e9a011a884')
  })
})

describe('buildSandboxJobSpec', () => {
  it('mirrors the huggingface_hub dedicated-sandbox job spec', () => {
    const spec = buildSandboxJobSpec({
      image: 'node:22-alpine', flavor: 'cpu-basic', idleTimeoutSecs: 600,
      nonce: 'n0nce', token: 'tok', name: 'loop-code-sandbox', endpoint: 'https://huggingface.co',
    })
    expect(spec.dockerImage).toBe('node:22-alpine')
    expect(spec.command[0]).toBe('/bin/sh')
    expect(spec.command[2]).toContain('sha256sum')
    expect(spec.command[2]).toContain('exec "$d"')
    expect(spec.environment.SBX_PORT).toBe('49983')
    expect(spec.environment.SBX_IDLE_TIMEOUT).toBe('600')
    expect(spec.environment.SBX_SERVER_URL).toBe(`https://huggingface.co/buckets/huggingface/sbx-server/resolve/sbx-server-${SANDBOX_SERVER_SHA256}`)
    expect(spec.environment.SBX_SERVER_SHA256).toBe(SANDBOX_SERVER_SHA256)
    expect(spec.secrets).toEqual({ SBX_TOKEN: 'tok' })
    expect(spec.labels).toMatchObject({ 'hf-sandbox': '1', 'hf-sandbox-mode': 'dedicated', 'hf-sandbox-nonce': 'n0nce' })
    expect(spec.volumes).toEqual([{ type: 'bucket', source: 'huggingface/sbx-server', mountPath: '/.hf-sbx-server', readOnly: true }])
    expect(spec.expose).toEqual({ ports: [49983], portsPublic: [] })
    expect(spec.timeoutSeconds).toBe(86400)
    // The HF token itself must never be placed in the job environment/secrets.
    expect(JSON.stringify(spec.environment)).not.toContain('HF_TOKEN')
  })
})

describe('findServerUrl', () => {
  it('extracts the exposed 49983 URL', () => {
    expect(findServerUrl(JOB)).toBe('https://job123--49983.hf.jobs')
  })
  it('accepts the snake_case fallback and rejects jobs without the port', () => {
    expect(findServerUrl({ id: 'x', status: { expose_urls: ['https://x--49983.hf.jobs/'] } })).toBe('https://x--49983.hf.jobs')
    expect(() => findServerUrl({ id: 'y', status: { exposeUrls: ['https://y--8000.hf.jobs'] } })).toThrow(HfSandboxError)
  })
})

// ── createSandbox ───────────────────────────────────────────────────────────

describe('createSandbox', () => {
  it('creates a job, waits for health, and returns the handle', async () => {
    const { calls, fetchImpl } = makeFetch([
      {
        match: (url, init) => url === 'https://huggingface.co/api/jobs/test-ns' && init.method === 'POST',
        respond: () => fakeResponse(200, JOB),
      },
      {
        match: (url) => url === 'https://job123--49983.hf.jobs/health',
        respond: () => fakeResponse(200, { status: 'ok', protocol: 3 }),
      },
    ])
    const handle = await createSandbox(depsOf(fetchImpl), { image: 'node:22-alpine', name: 'loop-code-sandbox' })
    expect(handle.jobId).toBe('job123')
    expect(handle.baseUrl).toBe('https://job123--49983.hf.jobs')
    // Token is derived from HF_TOKEN env (test sets it below) + the job nonce.
    const specCall = calls.find((c) => c.init.method === 'POST')!
    const spec = JSON.parse(specCall.init.body)
    expect(spec.dockerImage).toBe('node:22-alpine')
    expect(spec.labels['hf-sandbox-mode']).toBe('dedicated')
    expect(handle.token).toBe(deriveSandboxToken(process.env.HF_TOKEN || '', spec.labels['hf-sandbox-nonce']))
    expect(specCall.init.headers.Authorization).toBe(`Bearer ${process.env.HF_TOKEN}`)
    expect(specCall.init.redirect).toBe('manual')
  })

  it('maps a 402 to a billing error', async () => {
    const { fetchImpl } = makeFetch([
      { match: () => true, respond: () => fakeResponse(402, { error: 'Payment Required' }) },
    ])
    await expect(createSandbox(depsOf(fetchImpl))).rejects.toMatchObject({ code: 'billing', status: 402 })
  })

  it('cancels the job when startup fails (no orphan)', async () => {
    const { calls, fetchImpl } = makeFetch([
      {
        match: (url, init) => url.endsWith('/api/jobs/test-ns') && init.method === 'POST',
        respond: () => fakeResponse(200, JOB),
      },
      {
        match: (url) => url.endsWith('/health'),
        respond: () => { throw new TypeError('connection refused') },
      },
      {
        match: (url, init) => url.endsWith('/api/jobs/test-ns/job123') && !init.method,
        respond: () => fakeResponse(200, { ...JOB, status: { ...JOB.status, stage: 'ERROR' } }),
      },
      {
        match: (url, init) => url.endsWith('/api/jobs/test-ns/job123') && init.method === 'DELETE',
        respond: () => fakeResponse(200, {}),
      },
    ])
    await expect(createSandbox(depsOf(fetchImpl))).rejects.toMatchObject({ code: 'startup' })
    expect(calls.some((c) => c.init.method === 'DELETE')).toBe(true)
  })

  it('refuses a server older than the required protocol', async () => {
    const { fetchImpl } = makeFetch([
      { match: (url, init) => init.method === 'POST', respond: () => fakeResponse(200, JOB) },
      { match: (url) => url.endsWith('/health'), respond: () => fakeResponse(200, { status: 'ok', protocol: 2 }) },
      { match: (url, init) => init.method === 'DELETE', respond: () => fakeResponse(200, {}) },
    ])
    await expect(createSandbox(depsOf(fetchImpl))).rejects.toMatchObject({ code: 'startup' })
  })
})

// ── exec ────────────────────────────────────────────────────────────────────

function ndjson(lines: object[]): Readable {
  return Readable.from(lines.map((line) => JSON.stringify(line) + '\n'))
}

describe('execInSandbox', () => {
  const handle = { jobId: 'job123', owner: 'test-ns', baseUrl: 'https://job123--49983.hf.jobs', token: 'tok' }

  it('parses the NDJSON stream: stdout/stderr/ping/exit with callbacks', async () => {
    const { fetchImpl } = makeFetch([
      {
        match: (url, init) => url === `${handle.baseUrl}/v1/exec` && init.method === 'POST',
        respond: () => fakeResponse(200, {}, ndjson([
          { event: 'start', pid: 42 },
          { event: 'ping' },
          { event: 'stdout', data: 'hel' },
          { event: 'stdout', data: 'lo\n' },
          { event: 'stderr', data: 'warn\n' },
          { event: 'exit', exit_code: 0, timed_out: false, duration_ms: 7 },
        ])),
      },
    ])
    const out: string[] = []
    const err: string[] = []
    const result = await execInSandbox(depsOf(fetchImpl), handle, {
      cmd: ['node', 'main.js'], shell: false, cwd: '/work', timeoutSecs: 30,
      onStdout: (c) => out.push(c), onStderr: (c) => err.push(c),
    })
    expect(result).toMatchObject({ exitCode: 0, timedOut: false, durationMs: 7, stdout: 'hello\n', stderr: 'warn\n' })
    expect(out.join('')).toBe('hello\n')
    expect(err.join('')).toBe('warn\n')
  })

  it('sends the sandbox token and the exec payload', async () => {
    const { calls, fetchImpl } = makeFetch([
      { match: () => true, respond: () => fakeResponse(200, {}, ndjson([{ event: 'exit', exit_code: 0 }])) },
    ])
    await execInSandbox(depsOf(fetchImpl), handle, { cmd: 'ls', shell: true })
    const call = calls[0]
    expect(call.init.headers['X-Sandbox-Token']).toBe('tok')
    expect(call.init.headers.Authorization).toBe(`Bearer ${process.env.HF_TOKEN}`)
    expect(JSON.parse(call.init.body)).toMatchObject({ cmd: 'ls', shell: true })
  })

  it('maps a 403 to an auth error', async () => {
    const { fetchImpl } = makeFetch([
      { match: () => true, respond: () => fakeResponse(403, { error: 'bad token' }) },
    ])
    await expect(execInSandbox(depsOf(fetchImpl), handle, { cmd: 'ls' })).rejects.toMatchObject({ code: 'auth' })
  })

  it('refuses to send credentials to a non-HF host', async () => {
    const { calls, fetchImpl } = makeFetch([])
    await expect(execInSandbox(depsOf(fetchImpl), { ...handle, baseUrl: 'https://evil.example.com' }, { cmd: 'ls' }))
      .rejects.toMatchObject({ code: 'api' })
    expect(calls).toHaveLength(0)
  })

  it('fails when the stream ends without an exit event', async () => {
    const { fetchImpl } = makeFetch([
      { match: () => true, respond: () => fakeResponse(200, {}, ndjson([{ event: 'stdout', data: 'x' }])) },
    ])
    await expect(execInSandbox(depsOf(fetchImpl), handle, { cmd: 'ls' })).rejects.toMatchObject({ code: 'api' })
  })
})

describe('killSandbox', () => {
  it('deletes the job; 404 is already-gone, not an error', async () => {
    const { calls, fetchImpl } = makeFetch([
      { match: (url, init) => init.method === 'DELETE', respond: () => fakeResponse(404, { error: 'gone' }) },
    ])
    await expect(killSandbox(depsOf(fetchImpl), { jobId: 'job123', owner: 'test-ns' })).resolves.toBeUndefined()
    expect(calls[0].url).toBe('https://huggingface.co/api/jobs/test-ns/job123')
  })
})

// ── provider selection (execute_code wiring) ────────────────────────────────

describe('sandboxProviderEnv', () => {
  it('SANDBOX_PROVIDER wins over the legacy flag', () => {
    vi.stubEnv('SANDBOX_PROVIDER', 'hf')
    vi.stubEnv('SANDBOX_DOCKER', 'true')
    expect(sandboxProviderEnv()).toBe('hf')
  })
  it('honors the legacy SANDBOX_DOCKER flag when unset', () => {
    vi.stubEnv('SANDBOX_PROVIDER', '')
    vi.stubEnv('SANDBOX_DOCKER', 'false')
    expect(sandboxProviderEnv()).toBe('subprocess')
    vi.stubEnv('SANDBOX_DOCKER', 'true')
    expect(sandboxProviderEnv()).toBe('docker')
  })
  it('returns null when nothing is pinned (auto-detect path)', () => {
    vi.stubEnv('SANDBOX_PROVIDER', '')
    vi.stubEnv('SANDBOX_DOCKER', '')
    expect(sandboxProviderEnv()).toBeNull()
  })
})
