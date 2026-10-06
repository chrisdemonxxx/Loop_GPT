/**
 * Auto-compaction for unlimited chat context.
 *
 * Two memory tiers keep a conversation alive indefinitely:
 *  1. A running SUMMARY: when the working transcript passes the char budget,
 *     everything except the system head and the recent tail is folded into a
 *     dense summary message by the model itself. Prior summaries are fed back
 *     into the next pass, so the summary is cumulative across the whole chat.
 *  2. Durable FACTS: each pass extracts long-term user/project facts and
 *     writes them to the Memory table (kind 'compacted'), so they survive
 *     across conversations and ride future runs via getMemories().
 *
 * The recent tail always stays verbatim — the model never loses the thread
 * of the current exchange, only the distant middle.
 */
import type OpenAI from 'openai'
import type { ChatMessage } from './types'
import { completeOnce } from './llmClient'
import { prisma } from '../services/prisma'

/** Transcript char budget that triggers a compaction pass (~4 chars/token). */
export const COMPACT_THRESHOLD = 100_000
/** Re-compact mid-run only after this much growth since the last pass. */
const RECOMPACT_GROWTH = 30_000
/** Messages kept verbatim at the tail — the live thread. */
const KEEP_TAIL = 12
/** Cap on text handed to the summarizer (its own context must fit). */
const SUMMARY_INPUT_CAP = 90_000
const MAX_SUMMARY_TOKENS = 1400

export const SUMMARY_MARKER = '[Compacted memory of the earlier conversation]'

const SUMMARIZER_SYSTEM = [
  'You compact conversation transcripts into a dense running summary for an AI agent.',
  'Preserve exactly what the agent needs to continue as if it still saw the full transcript:',
  'user goals and explicit requests; decisions made and why; key facts, names, URLs,',
  'file paths, credentials or IDs mentioned; tool outcomes that matter (with their',
  'concrete results); artifacts produced (names); errors hit and how they were resolved;',
  'open tasks and the current plan.',
  'Drop: filler, dead ends, repeated attempts with identical outcomes, raw tool payload dumps.',
].join(' ')

const messageText = (m: ChatMessage): string =>
  typeof m.content === 'string'
    ? m.content
    : m.content.map((p: any) => (p.type === 'text' ? p.text : '[image]')).join('\n')

export function transcriptSize(msgs: ChatMessage[]): number {
  return msgs.reduce((n, m) => n + messageText(m).length, 0)
}

export function shouldCompact(msgs: ChatMessage[], sinceLastGrowth = 0): boolean {
  return (
    msgs.length > KEEP_TAIL + 2 &&
    transcriptSize(msgs) > COMPACT_THRESHOLD + sinceLastGrowth
  )
}

export interface CompactResult {
  compacted: boolean
  factsSaved: number
  summaryChars: number
}

/**
 * Fold the middle of `msgs` (in place) into the running summary message and
 * persist durable facts to Memory. Best-effort: any summarizer failure leaves
 * the transcript untouched (the elision tier still guards the window).
 */
export async function compactTranscript(opts: {
  msgs: ChatMessage[]
  client: OpenAI
  model: string
  userId?: string
  workspaceId?: string
  signal?: AbortSignal
  emit?: (message: string) => void
}): Promise<CompactResult> {
  const { msgs, client, model, userId, workspaceId, signal, emit } = opts
  if (!shouldCompact(msgs)) return { compacted: false, factsSaved: 0, summaryChars: 0 }

  const middle = msgs.slice(1, -KEEP_TAIL)
  let priorSummary = ''
  if (middle.length > 0 && messageText(middle[0]).startsWith(SUMMARY_MARKER)) {
    priorSummary = messageText(middle.shift() as ChatMessage)
  }
  if (middle.length === 0) return { compacted: false, factsSaved: 0, summaryChars: 0 }

  const serialized = middle
    .map((m) => `${m.role.toUpperCase()}: ${messageText(m).slice(0, 4000)}`)
    .join('\n\n')
  const input = (priorSummary ? `${priorSummary}\n\n--- NEW SEGMENT ---\n\n` : '') + serialized

  emit?.('Compacting earlier conversation…')

  const prompt = [
    input.slice(0, SUMMARY_INPUT_CAP),
    '',
    'Respond with exactly two sections:',
    'SUMMARY: the running summary (max 500 words, incorporating any prior summary above).',
    'FACTS: 0-5 lines, each "- fact" — only durable user/project facts worth remembering',
    'across ALL future conversations (preferences, identity, project specifics, credentials',
    'names). Write "FACTS: none" if nothing qualifies.',
  ].join('\n')

  let out = ''
  try {
    out = await completeOnce(
      client,
      model,
      [
        { role: 'system', content: SUMMARIZER_SYSTEM },
        { role: 'user', content: prompt },
      ],
      0.2,
      MAX_SUMMARY_TOKENS,
      signal,
    )
  } catch {
    return { compacted: false, factsSaved: 0, summaryChars: 0 } // elision tier still applies
  }

  const summaryMatch = /SUMMARY:\s*([\s\S]*?)(?=\n\s*FACTS:|$)/i.exec(out)
  const factsMatch = /FACTS:\s*([\s\S]*)$/i.exec(out)
  const summary = (summaryMatch?.[1] || out).trim()
  if (!summary) return { compacted: false, factsSaved: 0, summaryChars: 0 }

  // Splice: system head + [summary] + recent tail.
  const removed = 1 + middle.length + (priorSummary ? 1 : 0)
  msgs.splice(1, removed, { role: 'user', content: `${SUMMARY_MARKER}\n${summary}` })

  // Durable facts → Memory (deduped, respects the user's memory toggle).
  const facts = (factsMatch?.[1] || '')
    .split('\n')
    .map((l) => l.replace(/^\s*[-•*]\s*/, '').trim())
    .filter((l) => l.length > 8 && l.length <= 2000 && !/^none\.?$/i.test(l))
    .slice(0, 5)

  let factsSaved = 0
  if (facts.length > 0 && userId && prisma) {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { memoryEnabled: true } }).catch(() => null)
    if (!user || user.memoryEnabled) {
      for (const fact of facts) {
        try {
          const dupe = await prisma.memory.findFirst({ where: { userId, content: fact }, select: { id: true } })
          if (dupe) continue
          await prisma.memory.create({
            data: {
              userId,
              kind: 'compacted',
              source: 'agent',
              content: fact,
              tags: ['auto-compact'],
              projectId: workspaceId || undefined,
            },
          })
          factsSaved++
        } catch { /* memory is best-effort */ }
      }
    }
  }

  return { compacted: true, factsSaved, summaryChars: summary.length }
}

/** Mid-run policy: compact again only after meaningful growth since the last pass. */
export function shouldRecompact(msgs: ChatMessage[], lastCompactAtSize: number): boolean {
  return msgs.length > KEEP_TAIL + 2 && transcriptSize(msgs) > Math.max(COMPACT_THRESHOLD, lastCompactAtSize + RECOMPACT_GROWTH)
}
