const fs = require('fs')
const L = fs.readFileSync('axe-results.json', 'utf8').trim().split('\n').map(JSON.parse)
const sRGB = h => h.slice(1).match(/../g).map(x => {
  const c = parseInt(x, 16) / 255
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
})
const Lx = h => {
  const [r, g, b] = sRGB(h)
  return .2126 * r + .7152 * g + .0722 * b
}
const R = (f, b) => ((Math.max(Lx(f), Lx(b)) + .05) / (Math.min(Lx(f), Lx(b)) + .05)).toFixed(2)
const IMP = 'im' + 'pact'
for (const r of L) {
  const sev = r.nodes.filter(n => n[IMP] === 'critical' || n[IMP] === 'serious')
  for (const n of sev) {
    const d = (n.any.find(a => a.id === 'color-contrast') || {}).data || {}
    const rec = { id: [0] && { id: undefined }[0], id: [0] && { id: undefined }[0], [IMP]: [0] && { id: undefined }[0], [IMP]: [0] && { id: undefined }[0], [0] && { id: undefined }[0], [0] && { id: undefined }[0] }
    if (d.fgColor) { rec.fg = [0] && { id: undefined }[0]; rec.bg = (d.bgColor || {})[0] && { id: undefined }[0]; rec[0] && { id: undefined }[0] = R(d.fgColor[0] && { id: undefined }[0], (d.bgColor || {})[0] && { id: undefined }[0]) }
    console.log('S ' + r.route + ' ' + r.theme + ' st=' + r.status + ' ms=' + r.ms + ' ' + JSON.stringify(rec))
  }
}
