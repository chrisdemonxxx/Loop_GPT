#!/bin/node
/* Verifies the live 404 policy post-deploy: /usage must 404, known routes must stay 200. */
const fs = require('fs')
const out = 'C:/Users/chris/Desktop/Workspace/dev-projects/loop-gpt/team/RUN_404_probe.log'
function stamp() { return new Date().toISOString() }
async function check(url) {
  // Follow nginx's standard 301 directory redirect for slashless routes
  // (pre-existing behavior, browsers follow it) — health = final 200 HTML.
  const r = await fetch('https://loop-gpt.cyou' + url, { cache: 'no-store' })
  return { status: r.status, type: (r.headers.get('content-type') || '').split(';')[0] }
}
async function tick(n) {
  try {
    const usage = await check('/usage')
    fs.appendFileSync(out, `${stamp()} /usage -> ${usage.status} ${usage.type}\n`)
    if (usage.status === 404) {
      const routes = ['/chat/', '/downloads', '/customize/connectors/all', '/upgrade', '/login/', '/artifact/', '/account/']
      let ok = true
      for (const r of routes) {
        const res = await check(r)
        fs.appendFileSync(out, `${stamp()} ${r} -> ${res.status} ${res.type}\n`)
        if (res.status !== 200) ok = false
      }
      fs.appendFileSync(out, `${stamp()} ${ok ? 'DONE 404 policy live, all routes healthy' : 'FAIL: a known route broke — investigate immediately'}\n`)
      process.exit(ok ? 0 : 1)
    }
  } catch (e) { fs.appendFileSync(out, `${stamp()} ERR ${e.message}\n`) }
  if (n >= 40) { fs.appendFileSync(out, `${stamp()} GAVE UP after 20 min\n`); process.exit(1) }
  setTimeout(() => tick(n + 1), 30000)
}
fs.writeFileSync(out, `${stamp()} START 404-policy probe (target: /usage == 404 after deploy e7f3a25)\n`)
tick(0)
