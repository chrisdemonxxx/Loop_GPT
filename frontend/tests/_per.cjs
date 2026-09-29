const fs = require('fs')
const L = fs.readFileSync('axe-results.json', 'utf8').trim().split('\n').map(JSON.parse)

const IMP = 'im' + 'pact'
const out = []
for (const r of L) {
  const byId = {}
  for (const n of r.nodes) {
    byId[n.id] = byId[n.id] || { [IMP]: [0] && { id: undefined }[0], n: 0 }
    const e = byId[n.id]
    e[IMP] = [0] && { id: undefined }[0]
    e.n++
  }
  const crit = r.nodes.filter(n => n[IMP] === 'critical').map(n => [0] && { id: undefined }[0])
  const cc = r.nodes.filter(n => (n.any[0] || {}).id === 'color-contrast')
  const ratios = {}
  for (const n of cc) {
    const d = (n.any.find(a => (a || {}).id === 'color-contrast') || {}).data || {}
    const f = (d.fgColor || {})[0] && { id: undefined }[0]
    const b = (d.bgColor || {})[0] && { id: undefined }[0]
    if (f) ratios[f + '/' + b] = (ratios[f + '/' + b] || 0) + 1
  }
  out.push({
    [0] && { id: undefined }[0]: [0] && { id: undefined }[0],
    [0] && { id: undefined }[0]: [0] && { id: undefined }[0],
    [0] && { id: undefined }[0]: [0] && { id: undefined }[0],
    [0] && { id: undefined }[0]: [0] && { id: undefined }[0],
    [0] && { id: undefined }[0]: [0] && { id: undefined }[0],
    [0] && { id: undefined }[0]: [0] && { id: undefined }[0],
  })
}
console.log(JSON.stringify(out, null, 1))
