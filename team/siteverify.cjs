#!/bin/node
/* Site Verification automation: mints a scoped token from gcloud ADC, then
 * runs the FILE-method flow against loop-gpt.cyou. Secrets stay in memory;
 * only the derived filename + API responses are logged. */
const fs = require('fs')
const out = 'C:/Users/chris/Desktop/Workspace/dev-projects/loop-gpt/team/RUN_site_verification.log'
const log = (s) => fs.appendFileSync(out, s + '\n')
const ADC = JSON.parse(fs.readFileSync(process.env.APPDATA + '/gcloud/application_default_credentials.json', 'utf8'))

async function mintToken() {
  const body = new URLSearchParams({
    client_id: ADC.client_id,
    client_secret: ADC.client_secret,
    refresh_token: ADC.refresh_token,
    grant_type: 'refresh_token',
  })
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', body })
  const j = await r.json()
  if (!j.access_token) throw new Error('token mint failed: ' + JSON.stringify(j).slice(0, 200))
  return j
}

async function main() {
  fs.writeFileSync(out, new Date().toISOString() + ' START site verification (FILE method)\n')
  const { access_token: tok, scope } = await mintToken()
  log(`token minted; scopes: ${scope}`)

  // 1. get the FILE verification token for the site (quota project header
  //    required for user-credential ADC calls)
  const tokenRes = await fetch('https://www.googleapis.com/siteVerification/v1/token?verificationMethod=FILE', {
    method: 'POST',
    headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json', 'X-Goog-User-Project': 'midyear-diorama-509220-d7' },
    body: JSON.stringify({ site: { identifier: 'https://loop-gpt.cyou', type: 'SITE' } }),
  })
  const tokenBody = await tokenRes.json()
  log(`GET token: HTTP ${tokenRes.status} ${JSON.stringify(tokenBody)}`)
  if (!tokenRes.ok || !tokenBody.token) { log('FAILED at token step'); process.exit(1) }

  const token = tokenBody.token
  fs.writeFileSync('C:/Users/chris/Desktop/Workspace/dev-projects/loop-gpt/team/SV_FILE_TOKEN.txt', token)
  log(`token written to team/SV_FILE_TOKEN.txt (len ${token.length})`)

  // For FILE method the API's token string doubles as the filename AND the
  // content prefix: file "google<hash>.html" containing
  // "google-site-verification: google<hash>.html".
  const fileName = token.trim().endsWith('.html') ? token.trim() : `${token.trim()}.html`
  const content = `google-site-verification: ${token.trim()}`
  fs.writeFileSync(`C:/Users/chris/Desktop/Workspace/dev-projects/loop-gpt/frontend/public/${fileName}`, content)
  log(`wrote frontend/public/${fileName} (content: ${content})`)
}

main().catch((e) => { log('ERR ' + e.message); process.exit(1) })
