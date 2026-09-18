// Local smoke fixture only; never copied into either deliverable image.
import { createServer } from 'node:http'
let disconnected = false
createServer((req, res) => {
  if (req.url === '/api/disconnected') { res.end(JSON.stringify({ disconnected })); return }
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
