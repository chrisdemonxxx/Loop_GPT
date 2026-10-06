/** Attach to the running Loop GPT (CDP :9222), capture console + network
 *  errors for N seconds, and snapshot the auth state + a probe API call. */
import WebSocket from 'ws'

const targets = await (await fetch('http://127.0.0.1:9222/json')).json()
const page = targets.find((t) => t.type === 'page')
if (!page) { console.error('no page target'); process.exit(1) }

const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false })
let id = 0
const send = (method, params = {}) => ws.send(JSON.stringify({ id: ++id, method, params }))
const events = []

ws.on('open', () => {
  send('Runtime.enable')
  send('Network.enable')
  // Snapshot: auth state + direct API probes from inside the page.
  send('Runtime.evaluate', {
    returnByValue: true,
    expression: `(() => {
      const token = localStorage.getItem('authToken')
      const user = localStorage.getItem('user')
      return { hasToken: !!token, tokenLen: token ? token.length : 0, tokenHead: token ? token.slice(0, 24) : null, user: user ? user.slice(0, 140) : null, origin: location.origin, url: location.href }
    })()`,
  })
  // Fire the same calls the app makes, see status codes.
  send('Runtime.evaluate', {
    awaitPromise: true, returnByValue: true,
    expression: `(async () => {
      const out = {}
      const h = {}
      const t = localStorage.getItem('authToken')
      if (t) h['Authorization'] = 'Bearer ' + t
      h['Content-Type'] = 'application/json'
      for (const p of ['/api/conversations', '/api/workspaces', '/api/settings/guest-mode']) {
        try { const r = await fetch(p, { headers: h }); out[p] = { status: r.status, body: (await r.text()).slice(0, 180) } }
        catch (e) { out[p] = { error: String(e) } }
      }
      return out
    })()`,
  })
})

const timer = setTimeout(() => {
  console.log('\n=== CAPTURED EVENTS ===')
  for (const e of events) console.log(e)
  process.exit(0)
}, 15000)

ws.on('message', (raw) => {
  const msg = JSON.parse(raw)
  if (msg.id) {
    if (msg.result?.result?.value !== undefined) {
      console.log('\n=== EVAL RESULT ' + msg.id + ' ===')
      console.log(JSON.stringify(msg.result.result.value, null, 2).slice(0, 2400))
    }
    return
  }
  const { method, params } = msg
  if (method === 'Runtime.consoleAPICalled') {
    const level = params.type
    const text = params.args.map((a) => a.value ?? a.description ?? '').join(' ')
    if (level === 'error' || level === 'warning') events.push(`[console.${level}] ${text.slice(0, 400)}`)
  } else if (method === 'Runtime.exceptionThrown') {
    events.push(`[exception] ${params.exceptionDetails.text} ${params.exceptionDetails.exception?.description?.slice(0, 500) || ''}`)
  } else if (method === 'Network.loadingFailed') {
    events.push(`[net:failed] ${params.requestId} ${params.errorText} blocked=${params.blockedReason || ''}`)
  } else if (method === 'Network.responseReceived') {
    const r = params.response
    if (r.status >= 400) events.push(`[net:${r.status}] ${r.url.slice(0, 160)}`)
  }
})
ws.on('error', (e) => { console.error('ws error', e.message); process.exit(1) })