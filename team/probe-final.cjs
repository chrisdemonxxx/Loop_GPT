#!/bin/node
/* Final read-back: BOTH /version.json and /api/version must equal 5ec8bd1. */
const fs = require('fs')
const out = 'C:/Users/chris/Desktop/Workspace/dev-projects/loop-gpt/team/RUN_final_readback.log'
const TARGET = '31053b639eca600754f24157cb8844ac4507d6a9'
function stamp() { return new Date().toISOString() }
async function getJson(url) {
  const r = await fetch('https://loop-gpt.cyou' + url, { cache: 'no-store' })
  const type = (r.headers.get('content-type') || '').split(';')[0]
  if (!r.ok || !type.includes('json')) return { err: `HTTP ${r.status} ${type}` }
  return await r.json()
}
async function tick(n) {
  try {
    const web = await getJson('/version.json')
    const api = await getJson('/api/version')
    const wRev = web.revision || web.err
    const aRev = api.revision || api.err
    fs.appendFileSync(out, `${stamp()} web=${wRev} api=${aRev}\n`)
    if (web.revision === TARGET && api.revision === TARGET) {
      fs.appendFileSync(out, `${stamp()} DONE both markers == ${TARGET}\n`)
      process.exit(0)
    }
  } catch (e) { fs.appendFileSync(out, `${stamp()} ERR ${e.message}\n`) }
  if (n >= 40) { fs.appendFileSync(out, `${stamp()} GAVE UP after 20 min\n`); process.exit(1) }
  setTimeout(() => tick(n + 1), 30000)
}
fs.writeFileSync(out, `${stamp()} START final read-back (target ${TARGET})\n`)
tick(0)

