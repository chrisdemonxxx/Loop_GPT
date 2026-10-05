#!/bin/node
/* Polls /version.json every 20s until revision != "unknown" (max 30 min), logs raw lines. */
const fs = require('fs')
const out = 'C:/Users/chris/Desktop/Workspace/dev-projects/loop-gpt/team/RUN_version_probe.log'
const target = '3260a24'
function stamp() { return new Date().toISOString() }
function tick(n) {
  fetch('https://loop-gpt.cyou/version.json', { cache: 'no-store' })
    .then((r) => r.text().then((b) => ({ status: r.status, body: b })))
    .then(({ status, body }) => {
      fs.appendFileSync(out, `${stamp()} HTTP=${status} ${body.trim()}\n`)
      let done = false
      try { done = JSON.parse(body).revision && JSON.parse(body).revision !== 'unknown' } catch {}
      if (done) {
        fs.appendFileSync(out, `${stamp()} DONE revision served; target HEAD ${target}\n`)
        process.exit(0)
      }
      if (n >= 90) { fs.appendFileSync(out, `${stamp()} GAVE UP after 30 min\n`); process.exit(1) }
      setTimeout(() => tick(n + 1), 20000)
    })
    .catch((e) => {
      fs.appendFileSync(out, `${stamp()} ERR ${e.message}\n`)
      if (n >= 90) process.exit(1)
      setTimeout(() => tick(n + 1), 20000)
    })
}
fs.writeFileSync(out, `${stamp()} START polling /version.json (target HEAD ${target})\n`)
tick(0)
