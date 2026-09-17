#!/usr/bin/env node
// Usage: node scripts/provider-transport-smoke.cjs (after npm run build).
// Also runs as UID 1000 inside the runtime image with --network none and this
// script mounted read-only at /app/scripts/provider-transport-smoke.cjs.
// Uses only a temporary loopback server; no provider credentials or external DNS.
const assert = require('node:assert/strict')
const http = require('node:http')
const { once } = require('node:events')

async function main() {
  const { providerRequest, sidecarRequest } = require('../dist/services/providerHttp')
  let mode = 'healthy'
  let requests = 0
  const server = http.createServer((req, res) => {
    requests++
    assert.equal(req.url, '/health')
    assert.equal(req.headers['accept-encoding'], 'identity')
    assert.equal(req.headers.authorization, undefined)
    if (mode === 'redirect') { res.writeHead(302, { location: '/health' }); res.end(); return }
    if (mode === 'encoded') { res.writeHead(200, { 'content-encoding': 'gzip' }); res.end('fixture'); return }
    res.writeHead(200, { 'content-type': 'application/json' })
    if (mode === 'stall') { res.flushHeaders(); return }
    res.end(mode === 'oversize' ? '12345' : '{"healthy":true}')
  })
  const previous = process.env.IMAGE_API_URL
  const watchdog = setTimeout(() => { console.error('Smoke watchdog expired'); process.exit(1) }, 10000)
  try {
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    process.env.IMAGE_API_URL = `http://127.0.0.1:${server.address().port}`
    assert.deepEqual(await (await sidecarRequest('/health')).json(), { healthy: true })
    console.log(`loopback sidecar healthy; uid=${process.getuid?.() ?? 'windows'}`)
    for (const [scenario, code, options] of [
      ['oversize', 'too_large', { maxBytes: 4 }],
      ['redirect', 'redirect_rejected', {}],
      ['encoded', 'invalid_response', {}],
      ['stall', 'timeout', { timeoutMs: 50 }],
    ]) {
      mode = scenario
      await assert.rejects(sidecarRequest('/health', options), { code })
      console.log(`${scenario} blocked`)
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 50)
    try { await assert.rejects(sidecarRequest('/health', { signal: controller.signal }), { code: 'aborted' }) }
    finally { clearTimeout(timer) }
    console.log('caller cancellation blocked stalled response')
    const before = requests
    await assert.rejects(providerRequest('https://127.0.0.1/health'), { code: 'blocked_destination' })
    await assert.rejects(sidecarRequest('/health', { headers: { Authorization: 'Bearer fixture' } }), { code: 'invalid_request' })
    assert.equal(requests, before)
    console.log('public-private destination and sidecar credentials rejected before dispatch')
  } finally {
    if (previous === undefined) delete process.env.IMAGE_API_URL
    else process.env.IMAGE_API_URL = previous
    clearTimeout(watchdog)
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
}
if (process.argv.includes('--help')) console.log('Usage: node scripts/provider-transport-smoke.cjs\nRequires compiled backend/dist. Uses temporary loopback HTTP only.')
else main().catch(error => { console.error(error); process.exitCode = 1 })
