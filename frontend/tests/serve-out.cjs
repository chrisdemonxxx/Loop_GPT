/** Static server for the Playwright e2e suite. Serves the built `out/` export. */
const http = require('http')
const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..', 'out')
const mime = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2',
}

http.createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0])
  let file = path.join(root, urlPath)
  let missing = false
  try { if (fs.statSync(file).isDirectory()) file = path.join(file, 'index.html') } catch {
    try { const asHtml = path.join(root, urlPath + '.html'); fs.statSync(asHtml); file = asHtml } catch { missing = true; file = path.join(root, '404.html') }
  }
  fs.readFile(file, (err, buf) => {
    if (err) { res.statusCode = 404; return res.end('not found') }
    // Mirrors the nginx 404 policy: unknown routes serve the exported 404
    // page WITH the 404 status (blueprint §4.3; the route spec asserts both).
    if (missing) res.statusCode = 404
    res.setHeader('Content-Type', mime[path.extname(file)] || 'application/octet-stream')
    res.end(buf)
  })
}).listen(4123, '127.0.0.1', () => console.log('e2e server on 4123'))
