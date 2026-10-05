#!/bin/node
/* Final step: POST webResource (FILE method) - Google fetches the hosted file
 * and records ownership on the ADC account (a Project Owner of both GCP
 * projects). Idempotent: re-running on an already-verified site returns the
 * existing resource. */
const fs = require('fs')
const out = 'C:/Users/chris/Desktop/Workspace/dev-projects/loop-gpt/team/RUN_site_verification.log'
const log = (s) => fs.appendFileSync(out, s + '\n')
const ADC = JSON.parse(fs.readFileSync(process.env.APPDATA + '/gcloud/application_default_credentials.json', 'utf8'))

async function main() {
  const mint = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    body: new URLSearchParams({
      client_id: ADC.client_id, client_secret: ADC.client_secret,
      refresh_token: ADC.refresh_token, grant_type: 'refresh_token',
    }),
  })
  const { access_token: tok } = await mint.json()
  if (!tok) throw new Error('token mint failed')

  const res = await fetch('https://www.googleapis.com/siteVerification/v1/webResource?verificationMethod=FILE', {
    method: 'POST',
    headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json', 'X-Goog-User-Project': 'midyear-diorama-509220-d7' },
    body: JSON.stringify({ site: { identifier: 'https://loop-gpt.cyou', type: 'SITE' } }),
  })
  const body = await res.json()
  log(new Date().toISOString() + ` VERIFY: HTTP ${res.status} ${JSON.stringify(body)}`)

  if (res.ok) {
    log('VERIFIED - loop-gpt.cyou ownership recorded on admin@red-kit.org')
    // Sanity: list the owned resources
    const list = await fetch('https://www.googleapis.com/siteVerification/v1/webResource', {
      headers: { Authorization: `Bearer ${tok}`, 'X-Goog-User-Project': 'midyear-diorama-509220-d7' },
    })
    log('OWNED: ' + JSON.stringify(await list.json()))
    process.exit(0)
  }
  process.exit(1)
}

main().catch((e) => { log('ERR ' + e.message); process.exit(1) })
