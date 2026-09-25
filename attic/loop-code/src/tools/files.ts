import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, mkdirSync } from 'fs'
import { join, resolve, relative } from 'path'

const MAX_READ = 40_000

export function readFile(path: string): string {
  const abs = resolve(path)
  if (!existsSync(abs)) return `Error: file not found: ${abs}`
  try {
    const content = readFileSync(abs, 'utf8')
    if (content.length > MAX_READ) return content.slice(0, MAX_READ) + `\n\n[... truncated at ${MAX_READ} chars]`
    return content
  } catch (e: any) {
    return `Error reading file: ${e.message}`
  }
}

export function writeFile(path: string, content: string): string {
  const abs = resolve(path)
  try {
    mkdirSync(require('path').dirname(abs), { recursive: true })
    writeFileSync(abs, content, 'utf8')
    return `Written ${content.length} chars to ${abs}`
  } catch (e: any) {
    return `Error writing file: ${e.message}`
  }
}

export function listDir(path: string, depth = 2): string {
  const abs = resolve(path || '.')
  if (!existsSync(abs)) return `Error: path not found: ${abs}`
  const lines: string[] = []
  function walk(dir: string, d: number, prefix: string) {
    if (d > depth) return
    const entries = readdirSync(dir).filter((n) => !n.startsWith('.') && n !== 'node_modules' && n !== 'dist' && n !== '__pycache__')
    for (const name of entries) {
      const full = join(dir, name)
      let st: ReturnType<typeof statSync>
      try { st = statSync(full) } catch { continue }
      const rel = relative(abs, full)
      if (st.isDirectory()) {
        lines.push(`${prefix}${name}/`)
        walk(full, d + 1, prefix + '  ')
      } else {
        const kb = (st.size / 1024).toFixed(1)
        lines.push(`${prefix}${name} (${kb} KB)`)
      }
    }
  }
  walk(abs, 0, '')
  return lines.slice(0, 300).join('\n') || '(empty)'
}

export function searchFiles(pattern: string, path: string): string {
  const { execSync } = require('child_process')
  const abs = resolve(path || '.')
  try {
    const out = execSync(`grep -rn --include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" --include="*.py" --include="*.md" -l "${pattern.replace(/"/g, '\\"')}" "${abs}" 2>/dev/null | head -20`, { timeout: 10000 }).toString()
    if (!out.trim()) return `No files found matching: ${pattern}`
    return out.trim()
  } catch {
    return `Search failed or no matches for: ${pattern}`
  }
}
