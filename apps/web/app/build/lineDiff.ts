const MAX_CELLS = 250_000

/**
 * Unified line diff of two file snapshots.
 * Returns null when the files are too large to diff in the browser — callers
 * should show the two snapshots with labels instead of a fake all-minus / all-plus diff.
 */
export function unifiedLineDiff(path: string, before: string, after: string): string | null {
  const a = before.replace(/\r\n/g, '\n').split('\n')
  const b = after.replace(/\r\n/g, '\n').split('\n')
  if ((a.length + 1) * (b.length + 1) > MAX_CELLS) return null
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i--) {
    const row = dp[i]!
    const next = dp[i + 1]!
    for (let j = b.length - 1; j >= 0; j--) {
      row[j] = a[i] === b[j] ? next[j + 1]! + 1 : Math.max(next[j]!, row[j + 1]!)
    }
  }
  const body: string[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      body.push(` ${a[i]}`)
      i += 1
      j += 1
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      body.push(`-${a[i]}`)
      i += 1
    } else {
      body.push(`+${b[j]}`)
      j += 1
    }
  }
  while (i < a.length) body.push(`-${a[i++]}`)
  while (j < b.length) body.push(`+${b[j++]}`)
  return [`--- a/${path}`, `+++ b/${path}`, `@@ -1,${a.length} +1,${b.length} @@`, ...body].join('\n')
}
