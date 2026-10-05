#!/bin/node
/* Live OAuth fix probe: fixture login -> gmail init -> authorizeUrl analysis. */
const fs = require('fs')
const out = 'C:/Users/chris/Desktop/Workspace/dev-projects/loop-gpt/team/RUN_oauth_fix_probe.log'
function log(s) { fs.appendFileSync(out, s + '\n') }
const BASE = 'https://loop-gpt.cyou'

async function main() {
  fs.writeFileSync(out, new Date().toISOString() + ' START oauth fix probe\n')
  // 1. fixture login
  const login = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'hr.mobile.probe.20260929@example.com', password: 'HrProbe!2941-aa' }),
  })
  const token = (await login.json()).token
  log(`login: HTTP ${login.status} token=${token ? token.slice(0, 12) + '…' : 'MISSING'}`)
  if (!token) process.exit(1)
  const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }

  // 2. workspaces
  const ws = await fetch(`${BASE}/api/workspaces`, { headers: auth })
  const wsBody = await ws.json().catch(() => null)
  log(`workspaces: HTTP ${ws.status} body=${JSON.stringify(wsBody).slice(0, 200)}`)
  let workspaceId = Array.isArray(wsBody) ? wsBody[0]?.id : wsBody?.workspaces?.[0]?.id || wsBody?.id
  if (!workspaceId) {
    // create a default workspace if listing gave nothing usable
    const create = await fetch(`${BASE}/api/workspaces`, { method: 'POST', headers: auth, body: JSON.stringify({ name: 'probe-ws' }) })
    const cb = await create.json().catch(() => null)
    log(`workspace create: HTTP ${create.status} ${JSON.stringify(cb).slice(0, 160)}`)
    workspaceId = cb?.id || cb?.workspace?.id
  }
  if (!workspaceId) { log('NO WORKSPACE — cannot init'); process.exit(1) }
  log(`workspaceId: ${workspaceId}`)

  // 3. gmail init (popup mode)
  const init = await fetch(`${BASE}/api/oauth-connector/init/gmail`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({ workspaceId, via: 'popup' }),
  })
  const initBody = await init.json().catch(() => null)
  log(`init gmail: HTTP ${init.status}`)
  log(`authorizeUrl: ${initBody?.authorizeUrl || JSON.stringify(initBody)}`)
  log(`redirectUri field: ${initBody?.redirectUri}`)
  if (!initBody?.authorizeUrl) process.exit(1)
  const ru = new URLSearchParams(new URL(initBody.authorizeUrl).search).get('redirect_uri')
  log(`redirect_uri param: ${ru}`)

  // 4. GET the authorizeUrl — Google answers before consent:
  //    registered URI → the sign-in/consent screen; unregistered → the
  //    Error 400 page the operator saw (body carries redirect_uri_mismatch).
  const page = await fetch(initBody.authorizeUrl, { redirect: 'manual' })
  const body = await page.text()
  log(`authorize page: HTTP ${page.status}`)
  const mismatch = /redirect_uri_mismatch|invalid_request|invalid client/.test(body)
  const looksConsent = /consent|accounts\.google\.com\/signin|Sign in with Google|gscont/.test(body)
  log(`VERDICT: ${mismatch ? 'STILL MISMATCH (URI not registered in the Google client)' : looksConsent ? 'URI REGISTERED - consent screen renders (fix works end-to-end)' : 'unknown page shape — inspect manually'}`)
  log(`body markers: mismatch=${mismatch} consent-ish=${looksConsent} len=${body.length}`)
  log(new Date().toISOString() + ' DONE')
}

main().catch((e) => { log(`ERR ${e.message}`); process.exit(1) })
