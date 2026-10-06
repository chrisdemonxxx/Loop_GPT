'use strict'

/**
 * The local gateway (sand's architecture: Grok Bot ships a local gateway too,
 * see its gateway-descriptor.json). A Node http server on 127.0.0.1 that:
 *  - serves the web app's static export at http://127.0.0.1:<port>/
 *  - proxies /api + /v1 to the backend with FULL HTTP fidelity — headers,
 *    bodies, and SSE streams — because it is a real http origin, not a
 *    Chromium custom protocol (whose fetches deliver EMPTY headers).
 */
const http = require('node:http')
const https = require('node:https')
const fs = require('node:fs')
const path = require('node:path')

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.txt': 'text/plain; charset=utf-8',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.wasm': 'application/wasm',
}

/** Hop-by-hop headers never forwarded on the API proxy. */
const HOP_BY_HOP = new Set([
  'host', 'connection', 'keep-alive', 'proxy-connection', 'te', 'trailer',
  'transfer-encoding', 'upgrade',
])

function isApiPath(pathname) {
  return pathname === '/api/' || pathname.startsWith('/api/')
    || pathname === '/v1/' || pathname.startsWith('/v1/')
}

/** Resolve a static-export path: directories → index.html (trailingSlash
 *  semantics), files with MIME types. Null when not present. */
function resolveStatic(exportDir, pathname) {
  const clean = path.normalize(pathname).replace(/^([/\\])+/, '')
  if (clean.startsWith('..')) return null
  let file = path.join(exportDir, clean)
  let stat = fs.statSync(file, { throwIfNoEntry: false })
  if (stat?.isDirectory()) {
    file = path.join(file, 'index.html')
    stat = fs.statSync(file, { throwIfNoEntry: false })
  }
  return stat?.isFile() ? file : null
}

function sendFile(res, file, status = 200) {
  const ext = path.extname(file).toLowerCase()
  res.writeHead(status, {
    'content-type': MIME[ext] || 'application/octet-stream',
    'cache-control': ext === '.html' ? 'no-store' : 'public, max-age=3600',
  })
  fs.createReadStream(file).pipe(res)
}

/**
 * Start the gateway. Tries the preferred port first (stable origin keeps
 * localStorage across sessions), then nearby ports, then ephemeral.
 * Resolves with { port, server, close }.
 */
function startGateway({ exportDir, apiBase, fallbackPage, log = () => {} }) {
  const api = new URL(apiBase)
  const client = api.protocol === 'https:' ? https : http
  const preferred = Number(process.env.LOOP_GATEWAY_PORT) || 47613

  const server = http.createServer((req, res) => {
    const pathname = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname)
    try {
      // ── API proxy (the nginx role): pipe request → backend → response.
      if (isApiPath(pathname)) {
        const headers = {}
        for (const [name, value] of Object.entries(req.headers)) {
          if (HOP_BY_HOP.has(name)) continue
          headers[name] = value
        }
        headers['host'] = api.host
        const upstream = client.request(
          {
            protocol: api.protocol,
            hostname: api.hostname,
            port: api.port || (api.protocol === 'https:' ? 443 : 80),
            path: req.url,
            method: req.method,
            headers,
          },
          (up) => {
            const out = {}
            for (const [name, value] of Object.entries(up.headers)) {
              if (HOP_BY_HOP.has(name)) continue
              out[name] = value
            }
            res.writeHead(up.statusCode, out)
            up.pipe(res) // SSE/streams pass through untouched
          },
        )
        upstream.on('error', (err) => {
          log('gateway proxy error:', req.url, err.message)
          if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' })
          res.end('proxy error')
        })
        req.pipe(upstream) // bodies (uploads, JSON) stream through
        return
      }

      // ── Static export.
      const file = resolveStatic(exportDir, pathname)
      if (file) return sendFile(res, file)
      const missing = resolveStatic(exportDir, '/404.html')
      if (missing) return sendFile(res, missing, 404)

      // The export itself is missing (repo mode without a build): the shell's
      // recovery page.
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(fs.readFileSync(fallbackPage))
    } catch (err) {
      log('gateway error:', req.url, err)
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' })
      res.end('server error')
    }
  })

  return new Promise((resolve) => {
    const tryPort = (port, onFail) => {
      server.once('error', () => { onFail() })
      server.listen(port, '127.0.0.1', () => {
        log(`gateway listening on http://127.0.0.1:${port}`)
        resolve({ port, server, close: () => server.close() })
      })
    }
    const fallbackRandom = () => tryPort(0, () => resolve(null))
    const nextPort = (n) => {
      if (n > 8) return fallbackRandom()
      tryPort(preferred + n, () => nextPort(n + 1))
    }
    tryPort(preferred, () => nextPort(1))
  })
}

module.exports = { startGateway }