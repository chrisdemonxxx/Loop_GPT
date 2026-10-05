#!/bin/node
/* Polls /api/models/catalog every 30s until 3 rows (or the vision row) appear; logs raw lines. */
const fs = require('fs')
const out = 'C:/Users/chris/Desktop/Workspace/dev-projects/loop-gpt/team/RUN_catalog_probe.log'
function stamp() { return new Date().toISOString() }
function tick(n) {
  fetch('https://loop-gpt.cyou/api/models/catalog', { cache: 'no-store' })
    .then((r) => r.text())
    .then((body) => {
      const done = body.includes('loop-vision')
      fs.appendFileSync(out, `${stamp()} rows=${(body.match(/"id":/g) || []).length} vision=${done ? 'YES' : 'no'} ${body.slice(0, 80)}…\n`)
      if (done) { fs.appendFileSync(out, `${stamp()} DONE row 3 live\n`); process.exit(0) }
      if (n >= 60) { fs.appendFileSync(out, `${stamp()} GAVE UP after 30 min\n`); process.exit(1) }
      setTimeout(() => tick(n + 1), 30000)
    })
    .catch((e) => {
      fs.appendFileSync(out, `${stamp()} ERR ${e.message}\n`)
      if (n >= 60) process.exit(1)
      setTimeout(() => tick(n + 1), 30000)
    })
}
fs.writeFileSync(out, `${stamp()} START polling catalog for loop-vision row\n`)
tick(0)
