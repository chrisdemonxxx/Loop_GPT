/**
 * Research scratchpad (brief §2.6 / GAP-046): durable per-phase state for deep
 * research runs. Each phase's output (plan queries, search hits, fetched
 * sources) is persisted keyed by a normalized query hash, so a run that is
 * interrupted — backend restart, client reload, transient failure — resumes
 * from the last completed phase instead of re-running (and re-paying for)
 * searches and fetches. Rows expire after 24h; all scratchpad IO fails open
 * (research never breaks because the scratchpad is unavailable).
 */
import { createHash } from 'crypto'
import { prisma } from './prisma'
import type { SearchResult } from '../agent/tools/webSearch'

const TTL_MS = 24 * 3600 * 1000

/** Minimal shape of a fetched research source (mirrors deepResearch's
 * FetchedSource — kept local to avoid importing the whole research module). */
export interface ScratchSource { index: number; title: string; url: string; text: string }

export interface ResearchScratch {
  queries?: string[]
  hits?: SearchResult[]
  sources?: ScratchSource[]
}

export function queryHash(query: string): string {
  return createHash('sha1').update(query.toLowerCase().replace(/\s+/g, ' ').trim()).digest('hex')
}

async function expireOld() {
  try { await prisma!.researchScratchpad.deleteMany({ where: { updatedAt: { lt: new Date(Date.now() - TTL_MS) } } }) } catch { /* fail open */ }
}

/** Load whatever phase state exists for a query (or null). */
export async function loadScratchpad(userId: string, query: string): Promise<ResearchScratch | null> {
  if (!prisma) return null
  try {
    const row: any = await prisma.researchScratchpad.findUnique({ where: { userId_queryHash: { userId, queryHash: queryHash(query) } } })
    if (!row) return null
    return {
      queries: Array.isArray(row.queries) ? row.queries as string[] : undefined,
      hits: Array.isArray(row.hits) ? row.hits as unknown as SearchResult[] : undefined,
      sources: Array.isArray(row.sources) ? row.sources as unknown as ScratchSource[] : undefined,
    }
  } catch {
    return null
  }
}

/** Merge-save phase outputs for a query (upsert; keeps earlier phases). */
export async function saveScratchpad(
  userId: string,
  query: string,
  phase: 'queries' | 'hits' | 'sources',
  payload: unknown,
): Promise<void> {
  if (!prisma) return
  try {
    await expireOld()
    const json = JSON.parse(JSON.stringify(payload))
    const data: any = phase === 'queries'
      ? { queries: json }
      : phase === 'hits'
        ? { hits: json }
        : { sources: json }
    await prisma.researchScratchpad.upsert({
      where: { userId_queryHash: { userId, queryHash: queryHash(query) } },
      create: { userId, queryHash: queryHash(query), query: query.slice(0, 500), ...data },
      update: data,
    })
  } catch { /* fail open */ }
}
