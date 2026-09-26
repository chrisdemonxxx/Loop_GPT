/**
 * Branch-view derivation (audit §8-22): from the full row set + the
 * conversation's active leaf, compute what the transcript displays — the
 * active path — and, per displayed row, the <2/3> version-group info for
 * the arrows (retries and edits become siblings under the same parent).
 *
 * Kept pure: both the hook and the tests exercise this with plain data.
 */
import type { Message } from '../components/chat/types'

export interface BranchVersionInfo {
  /** 1-based position of the displayed row among its siblings. */
  index: number
  /** Total versions in this group. */
  count: number
  /** The sibling shown when clicking < (undefined at the oldest). */
  prev?: Message
  /** The sibling shown when clicking > (undefined at the newest). */
  next?: Message
}

export interface BranchView {
  /** The rows the transcript renders, root → leaf. */
  path: Message[]
  /** Version-arrow data per displayed row (only rows with siblings). */
  versions: Record<string, BranchVersionInfo>
}

const ROOT_KEY = '__root__'

/** Sort siblings oldest-first — arrow order matches creation order. */
const byCreated = (a: Message, b: Message) =>
  a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)

export function buildBranchView(rows: Message[], activeLeafId?: string | null): BranchView {
  const hasTree = rows.some((r) => r.parentId !== undefined)
  if (!hasTree) {
    // Legacy payload (no parentId served — e.g. the flat memory-store
    // fallback): the chronology IS the path.
    return { path: rows, versions: {} }
  }
  const byId = new Map(rows.map((r) => [r.id, r]))

  let path: Message[]
  if (activeLeafId && byId.has(activeLeafId)) {
    // Walk leaf → root, then reverse. A seen-set guards against corrupt
    // parent cycles; a missing parent just ends the walk.
    const pathIds: string[] = []
    const seen = new Set<string>()
    let cursor: string | null | undefined = activeLeafId
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor)
      pathIds.push(cursor)
      cursor = byId.get(cursor)?.parentId ?? null
    }
    pathIds.reverse()
    path = pathIds.map((id) => byId.get(id)!).filter(Boolean)
  } else {
    // No active leaf known: fall back to chronology (pre-branch state).
    path = [...rows].sort(byCreated)
  }

  // Sibling groups across ALL rows (off-path versions included — they are
  // what the arrows flip to), keyed by shared parent.
  const byParent = new Map<string, Message[]>()
  for (const r of rows) {
    const key = r.parentId ?? ROOT_KEY
    const bucket = byParent.get(key)
    if (bucket) bucket.push(r)
    else byParent.set(key, [r])
  }

  const versions: Record<string, BranchVersionInfo> = {}
  for (const m of path) {
    const siblings = (byParent.get(m.parentId ?? ROOT_KEY) || []).sort(byCreated)
    if (siblings.length < 2) continue
    const idx = siblings.findIndex((s) => s.id === m.id)
    if (idx < 0) continue
    versions[m.id] = {
      index: idx + 1,
      count: siblings.length,
      prev: idx > 0 ? siblings[idx - 1] : undefined,
      next: idx < siblings.length - 1 ? siblings[idx + 1] : undefined,
    }
  }
  return { path, versions }
}
