// Extract the auth JWT from the running Loop GPT desktop app's leveldb log.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'

const dir = path.join(process.env.APPDATA, 'Loop GPT', 'Local Storage', 'leveldb')
const files = readdirSync(dir)
  .filter((f) => f.endsWith('.log') || f.endsWith('.ldb'))
  .map((f) => path.join(dir, f))
  .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)

for (const file of files) {
  const buf = readFileSync(file)
  const text = buf.toString('latin1')
  const matches = [...text.matchAll(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g)]
  if (matches.length > 0) {
    // Longest match is the freshest full JWT (leveldb stores latest at tail).
    const best = matches.map((m) => m[0]).sort((a, b) => b.length - a.length)[0]
    process.stdout.write(best)
    process.exit(0)
  }
}
process.stderr.write('no token found')
process.exit(1)
