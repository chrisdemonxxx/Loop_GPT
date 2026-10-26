/**
 * Memory and delta buffers for DevTools console and network events.
 *
 * Decision 13:
 * - Tab ring buffer: up to 2,000 console lines, 1,000 requests, 64 KB per body.
 * - Paged 100 at a time for whole-log requests.
 * - Per-action delta: 50 console lines (errors and warnings prioritized),
 *   40 network entries, bodies up to 4 KB each, 16 KB total payload cap.
 */

const MAX_CONSOLE_BUFFER = 2000
const MAX_NETWORK_BUFFER = 1000
const MAX_STORED_BODY_BYTES = 64 * 1024

const DELTA_CONSOLE_LIMIT = 50
const DELTA_NETWORK_LIMIT = 40
const DELTA_BODY_BYTES_PER_REQ = 4 * 1024
const DELTA_TOTAL_BODY_CAP = 16 * 1024

export function createBuffers() {
  const consoleLines = []
  const network = []
  const byId = new Map()
  let consoleCursor = 0
  let networkCursor = 0

  return {
    pushConsole(line) {
      consoleLines.push(line)
      if (consoleLines.length > MAX_CONSOLE_BUFFER) consoleLines.shift()
    },

    noteRequest(id, entry) {
      const row = { ...entry, requestId: id }
      byId.set(id, row)
      network.push(row)
      if (network.length > MAX_NETWORK_BUFFER) {
        const evicted = network.shift()
        if (evicted) byId.delete(evicted.requestId)
      }
    },

    attachBody(id, body) {
      const row = byId.get(id)
      if (row && body != null) {
        row.body = String(body).slice(0, MAX_STORED_BODY_BYTES)
      }
    },

    takeDelta() {
      const unreadConsole = consoleLines.slice(consoleCursor)
      consoleCursor = consoleLines.length

      // Prioritize error & warn lines in console delta
      const errorsAndWarnings = []
      const others = []
      for (const item of unreadConsole) {
        if (item.level === 'error' || item.level === 'warn') {
          errorsAndWarnings.push(item)
        } else {
          others.push(item)
        }
      }
      const combinedConsole = [...errorsAndWarnings, ...others]
      const consoleDelta = combinedConsole.slice(0, DELTA_CONSOLE_LIMIT)
      const remainingConsole = Math.max(0, combinedConsole.length - DELTA_CONSOLE_LIMIT)

      const unreadNetwork = network.slice(networkCursor)
      networkCursor = network.length

      const selectedNetwork = unreadNetwork.slice(0, DELTA_NETWORK_LIMIT)
      const remainingNetwork = Math.max(0, unreadNetwork.length - DELTA_NETWORK_LIMIT)

      // Format network entries with body budget enforcement
      let totalBodyBytesUsed = 0
      const networkDelta = selectedNetwork.map((row) => {
        const pub = publicEntry(row)
        if (pub.body) {
          if (totalBodyBytesUsed >= DELTA_TOTAL_BODY_CAP) {
            delete pub.body
          } else {
            const allowed = Math.min(DELTA_BODY_BYTES_PER_REQ, DELTA_TOTAL_BODY_CAP - totalBodyBytesUsed)
            pub.body = pub.body.slice(0, allowed)
            totalBodyBytesUsed += pub.body.length
          }
        }
        return pub
      })

      return {
        console: consoleDelta,
        network: networkDelta,
        consoleTruncated: remainingConsole > 0 ? remainingConsole : 0,
        networkTruncated: remainingNetwork > 0 ? remainingNetwork : 0,
      }
    },

    pageConsole(page, pageSize) {
      return pageOf(consoleLines, page, pageSize)
    },

    pageNetwork(page, pageSize) {
      return pageOf(network.map(publicEntry), page, pageSize)
    },

    clear() {
      consoleLines.length = 0
      network.length = 0
      byId.clear()
      consoleCursor = 0
      networkCursor = 0
    },
  }
}

function publicEntry(row) {
  return {
    url: row.url,
    method: row.method,
    status: row.status,
    type: row.type,
    timing: row.timing,
    body: row.body,
  }
}

function pageOf(items, page, pageSize) {
  const size = Math.min(Math.max(Number(pageSize) || 100, 1), 100)
  const index = Math.max(Number(page) || 1, 1)
  const start = (index - 1) * size
  return {
    entries: items.slice(start, start + size),
    page: index,
    pageSize: size,
    total: items.length,
  }
}
