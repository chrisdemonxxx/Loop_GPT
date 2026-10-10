// Local smoke fixture only; never copied into either deliverable image.
import { createServer } from 'node:http'
let disconnected = false
// Build-gateway probe state: one bearer minted per fixture process.
let issuedBearer = null
createServer((req, res) => {
  if (req.url === '/api/disconnected') { res.end(JSON.stringify({ disconnected })); return }
  // POST /api/loopit/token answers the exact mint contract the Loop-GPT
  // backend emits: { access_token, token, token_type, expires_in, expiresAt,
  // org, role }. The web client's createTokenStore parses token/expiresAt.
  if (req.url === '/api/loopit/token' && req.method === 'POST') {
    issuedBearer = `smoke-bearer-${Date.now().toString(36)}`
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify({
      access_token: issuedBearer,
      token: issuedBearer,
      token_type: 'bearer',
      expires_in: 900,
      expiresAt: new Date(Date.now() + 900_000).toISOString(),
      org: 'org_smoke',
      role: 'owner',
    }))
    return
  }
  // The engine data plane behind the /api/loopit prefix: /api/loopit/runs
  // arrives here as /api/runs (prefix stripped by nginx) and demands the bearer.
  if (req.url === '/api/runs' && req.method === 'GET') {
    if (!issuedBearer || req.headers.authorization !== `Bearer ${issuedBearer}`) {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ detail: 'authentication required' }))
      return
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end('[]')
    return
  }
  // Preview mint + token-prefixed site serving, in the engine's exact shapes:
  // POST /api/projects/<id>/preview answers a root-relative site URL, and the
  // site route serves it. The browser path is the gateway base plus that URL
  // with its own /api dropped (nginx re-adds /api after stripping the base).
  if (/^\/api\/projects\/[^/]+\/preview$/.test(req.url) && req.method === 'POST') {
    if (!issuedBearer || req.headers.authorization !== `Bearer ${issuedBearer}`) {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ detail: 'authentication required' }))
      return
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      url: '/api/projects/proj_smoke/site/t/smoke-token/index.html',
      expires_at: Date.now() + 900_000,
      token_type: 'signed_url',
    }))
    return
  }
  if (req.url === '/api/projects/proj_smoke/site/t/smoke-token/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Access-Control-Allow-Origin': '*' })
    res.end('<!doctype html>\n<html><body>fixture site</body></html>\n')
    return
  }
  if (req.url === '/api/stream' || req.url === '/v1/stream') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.write('data: first\n\n')
    const timer = setTimeout(() => res.end('data: last\n\n'), 1500)
    res.on('close', () => { disconnected = true; clearTimeout(timer) })
    return
  }
  let body = ''
  req.on('data', (chunk) => { body += chunk })
  req.on('end', () => {
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ url: req.url, method: req.method, authorization: req.headers.authorization, host: req.headers.host, body }))
  })
}).listen(3001, '::')
