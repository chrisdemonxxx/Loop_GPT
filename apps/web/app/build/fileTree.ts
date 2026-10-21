/** File tree + search helpers for the code drawer (Phase 3.1). */

export type FileTreeNode = {
  name: string
  path: string
  kind: 'file' | 'dir'
  children?: FileTreeNode[]
}

export function buildFileTree(files: string[]): FileTreeNode[] {
  type Mutable = { name: string; path: string; kind: 'file' | 'dir'; children?: Map<string, Mutable> }
  const root = new Map<string, Mutable>()

  for (const file of [...files].sort()) {
    const parts = file.split('/').filter(Boolean)
    if (!parts.length) continue
    let cursor = root
    let prefix = ''
    for (let i = 0; i < parts.length; i++) {
      const name = parts[i]!
      prefix = prefix ? `${prefix}/${name}` : name
      const isFile = i === parts.length - 1
      let node = cursor.get(name)
      if (!node) {
        node = { name, path: prefix, kind: isFile ? 'file' : 'dir', children: isFile ? undefined : new Map() }
        cursor.set(name, node)
      } else if (!isFile && node.kind === 'file') {
        node.kind = 'dir'
        node.children = new Map()
      }
      if (!isFile) cursor = node.children!
    }
  }

  const toList = (map: Map<string, Mutable>): FileTreeNode[] =>
    [...map.values()]
      .sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1
        return a.name.localeCompare(b.name)
      })
      .map((n) => ({
        name: n.name,
        path: n.path,
        kind: n.kind,
        children: n.children ? toList(n.children) : undefined,
      }))

  return toList(root)
}

export function filterFiles(files: string[], query: string): string[] {
  const q = query.trim().toLowerCase()
  if (!q) return files
  return files.filter((f) => f.toLowerCase().includes(q))
}

export function languageForPath(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  const map: Record<string, string> = {
    js: 'javascript',
    jsx: 'javascript',
    mjs: 'javascript',
    cjs: 'javascript',
    ts: 'typescript',
    tsx: 'typescript',
    json: 'json',
    html: 'html',
    htm: 'html',
    css: 'css',
    scss: 'scss',
    md: 'markdown',
    py: 'python',
    sh: 'shell',
    yml: 'yaml',
    yaml: 'yaml',
    svg: 'xml',
  }
  return map[ext] ?? 'plaintext'
}

/** localStorage key for per-project terminal history (Phase 3.2). */
export function terminalHistoryKey(projectId: string): string {
  return `loopit.terminal.history.${projectId}`
}

export type StoredTerminalEntry = {
  id: string
  command: string
  stdout: string
  stderr: string
  exitCode: number
  duration: number
}

export function loadTerminalHistory(projectId: string): StoredTerminalEntry[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(terminalHistoryKey(projectId))
    if (!raw) return []
    const parsed = JSON.parse(raw) as StoredTerminalEntry[]
    return Array.isArray(parsed) ? parsed.slice(-100) : []
  } catch {
    return []
  }
}

export function saveTerminalHistory(projectId: string, entries: StoredTerminalEntry[]): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(terminalHistoryKey(projectId), JSON.stringify(entries.slice(-100)))
  } catch {
    /* quota */
  }
}
