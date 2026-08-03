/**
 * Deep research: multi-phase orchestrated research agent modeled on
 * Claude.ai's /deep-research skill.
 *
 * Phases:
 *  1. Scope   — decompose query into 5-7 truly diverse search angles
 *  2. Search  — parallel web search across all angles, deduplicated
 *  3. Fetch   — parallel source reading (up to 15 sources, 6 000 chars each)
 *  4. Verify  — LLM extracts falsifiable claims + support/contradiction mapping
 *  5. Synthesise — streaming long-form cited report with confidence indicators
 *
 * Adversarial robustness: contested claims are flagged explicitly in the
 * output. The model is instructed to note gaps and uncertainties rather than
 * fabricate confidence.
 */
import type { AIProvider } from '../../services/aiProviders'
import { createClient, resolveModel, completeOnce, streamTurn } from '../llmClient'
import { searchWeb, type SearchResult } from '../tools/webSearch'
import { fetchReadable } from '../tools/webFetch'
import type { ChatMessage, ToolContext } from '../types'
import { agentConfig } from '../config'
import {
  CONFIDENTIALITY_PROMPT,
  sanitizeText,
  sanitizeMetadata,
  makeStreamSanitizer,
  guardrailsEnabled,
} from '../guardrails'

export interface DeepResearchOptions {
  query: string
  provider: AIProvider
  model: string
  apiKey?: string
  baseUrl?: string
  ctx: ToolContext
  maxQueries?: number
  maxSources?: number
}

export interface DeepResearchResult {
  content: string
  sources: Array<{ index: number; title: string; url: string }>
}

interface FetchedSource {
  index: number
  title: string
  url: string
  text: string
}

interface VerifiedClaim {
  claim: string
  confidence: 'HIGH' | 'MEDIUM' | 'LOW' | 'CONTESTED'
  supporting: number[]   // source indices
  contradicting: number[] // source indices
}

// ---------------------------------------------------------------------------
// Phase 1: Query planning — diverse angles, not paraphrases of the same query
// ---------------------------------------------------------------------------
async function planQueries(
  client: any,
  model: string,
  query: string,
  max: number
): Promise<string[]> {
  const systemPrompt = `You are a research strategist. Given a topic, generate ${max} DIVERSE search queries that together give comprehensive coverage.

Each query must explore a DIFFERENT angle. Use this checklist:
• Overview / definition / fundamentals
• Recent news / latest developments (2024-2025)
• Comparisons / alternatives / competitors
• Criticisms / limitations / controversies
• Expert opinions / academic research / studies
• Practical examples / real-world applications / case studies
• How-to / step-by-step / tutorials (if applicable)

Output ONLY a JSON array of strings. No explanation, no prose, no markdown.
Example: ["what is X", "X vs Y comparison 2025", "X limitations problems", "X research studies", "how to use X"]`

  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: `Topic: ${query}` },
  ]
  try {
    const out = await completeOnce(client, model, messages, 0.4, 600)
    const m = out.match(/\[[\s\S]*\]/)
    if (m) {
      const arr = JSON.parse(m[0])
      if (Array.isArray(arr) && arr.length > 0) {
        return arr.map(String).filter(Boolean).slice(0, max)
      }
    }
  } catch {
    /* fall through */
  }
  // Fallback: manually construct 4 angles
  return [
    query,
    `${query} latest news 2025`,
    `${query} research analysis`,
    `${query} how it works explained`,
  ].slice(0, max)
}

// ---------------------------------------------------------------------------
// Phase 2: Parallel web search across all angles
// ---------------------------------------------------------------------------
async function runSearchPhase(
  queries: string[],
  resultsPerQuery: number,
  step: number,
  ctx: ToolContext
): Promise<SearchResult[]> {
  const seen = new Set<string>()
  const hits: SearchResult[] = []

  await Promise.all(
    queries.map(async (q, qi) => {
      ctx.emit({ type: 'tool_call', step: step + qi, name: 'web_search', args: { query: q } })
      try {
        const results = await searchWeb(q, resultsPerQuery)
        let added = 0
        for (const r of results) {
          if (!seen.has(r.url)) {
            seen.add(r.url)
            hits.push(r)
            added++
          }
        }
        ctx.emit({
          type: 'tool_result',
          step: step + qi,
          name: 'web_search',
          content: `Found ${added} new results for "${q}" (${results.length} total)`,
          data: { results },
        })
      } catch (e: any) {
        ctx.emit({
          type: 'tool_result',
          step: step + qi,
          name: 'web_search',
          content: `Search failed: ${e?.message}`,
          isError: true,
        })
      }
    })
  )
  return hits
}

// ---------------------------------------------------------------------------
// Phase 3: Parallel source fetching
// ---------------------------------------------------------------------------
async function fetchPhase(
  hits: SearchResult[],
  maxSources: number,
  perSourceChars: number,
  startStep: number,
  ctx: ToolContext
): Promise<FetchedSource[]> {
  const chosen = hits.slice(0, maxSources)
  const sources: FetchedSource[] = []

  await Promise.all(
    chosen.map(async (r, i) => {
      const idx = i + 1
      ctx.emit({ type: 'tool_call', step: startStep + i, name: 'web_fetch', args: { url: r.url } })
      try {
        const { title, text } = await fetchReadable(r.url, perSourceChars)
        sources.push({ index: idx, title: title || r.title, url: r.url, text })
        ctx.emit({
          type: 'tool_result',
          step: startStep + i,
          name: 'web_fetch',
          content: `Read [${idx}] ${title || r.title} (${text.length} chars)`,
          data: { url: r.url },
        })
      } catch {
        sources.push({ index: idx, title: r.title, url: r.url, text: r.snippet })
        ctx.emit({
          type: 'tool_result',
          step: startStep + i,
          name: 'web_fetch',
          content: `Could not fully read [${idx}]; using snippet.`,
          isError: true,
        })
      }
    })
  )
  sources.sort((a, b) => a.index - b.index)
  return sources
}

// ---------------------------------------------------------------------------
// Phase 4: Adversarial claim extraction & verification
//
// The LLM reads ALL sources and extracts falsifiable claims, mapping which
// sources support and which contradict each claim. Contested claims are
// explicitly labelled so the synthesis can flag them.
// ---------------------------------------------------------------------------
async function extractAndVerifyClaims(
  client: any,
  model: string,
  query: string,
  sources: FetchedSource[],
  step: number,
  ctx: ToolContext
): Promise<VerifiedClaim[]> {
  ctx.emit({ type: 'tool_call', step, name: 'verify_claims', args: { numSources: sources.length } })

  // Truncate each source for the verification call (keep it fast)
  const verifyChars = 1500
  const compactBlock = sources
    .map((s) => `[${s.index}] ${s.title}\n${s.text.slice(0, verifyChars)}`)
    .join('\n\n---\n\n')

  const systemPrompt = `You are a rigorous fact-checker. Extract 6-12 key FALSIFIABLE claims from the sources below about the topic "${query}".

For each claim:
1. State it as a clear, specific assertion.
2. List which source numbers SUPPORT it.
3. List which source numbers CONTRADICT or cast doubt on it.
4. Rate confidence: HIGH (≥2 sources agree, none contradict), MEDIUM (1 source, no contradiction), LOW (limited evidence), CONTESTED (sources disagree).

Output ONLY valid JSON — no prose, no markdown:
[
  {
    "claim": "...",
    "confidence": "HIGH"|"MEDIUM"|"LOW"|"CONTESTED",
    "supporting": [1, 3],
    "contradicting": []
  }
]`

  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: `SOURCES:\n${compactBlock}` },
  ]

  try {
    const out = await completeOnce(client, model, messages, 0.2, 1200)
    const m = out.match(/\[[\s\S]*\]/)
    if (m) {
      const arr = JSON.parse(m[0])
      if (Array.isArray(arr)) {
        const claims = arr as VerifiedClaim[]
        ctx.emit({
          type: 'tool_result',
          step,
          name: 'verify_claims',
          content: `Verified ${claims.length} claims (${claims.filter((c) => c.confidence === 'CONTESTED').length} contested)`,
          data: { claims },
        })
        return claims
      }
    }
  } catch {
    /* fall through */
  }

  ctx.emit({
    type: 'tool_result',
    step,
    name: 'verify_claims',
    content: 'Claim extraction skipped; proceeding to synthesis.',
    isError: true,
  })
  return []
}

// ---------------------------------------------------------------------------
// Phase 5: Streaming synthesis
// ---------------------------------------------------------------------------
async function synthesizePhase(
  client: any,
  model: string,
  query: string,
  sources: FetchedSource[],
  claims: VerifiedClaim[],
  perSourceChars: number,
  step: number,
  ctx: ToolContext
): Promise<string> {
  ctx.emit({ type: 'warming', message: 'Synthesizing findings into a comprehensive report…' })

  const sourceBlock = sources
    .map((s) => `[${s.index}] ${s.title} — ${s.url}\n${s.text.slice(0, perSourceChars)}`)
    .join('\n\n---\n\n')

  const claimSection =
    claims.length > 0
      ? '\n\nVERIFIED CLAIMS (use these to structure your analysis):\n' +
        claims
          .map(
            (c) =>
              `• [${c.confidence}] ${c.claim} — supported by [${c.supporting.join(', ')}]` +
              (c.contradicting.length ? `, CONTESTED by [${c.contradicting.join(', ')}]` : '')
          )
          .join('\n')
      : ''

  const systemPrompt =
    (guardrailsEnabled ? CONFIDENTIALITY_PROMPT + '\n\n' : '') +
    `You are an expert research analyst. Write a comprehensive, well-structured deep-research report answering the user's query.

REQUIREMENTS:
- Use ONLY the provided sources and verified claims. Never fabricate facts.
- Cite every claim inline with [n] matching source numbers.
- Structure the report with clear Markdown headings (## and ###).
- Include ALL of these sections:
  1. **Executive Summary** — 3-5 sentence overview of key findings
  2. **Background & Context** — fundamentals, definitions, history
  3. **Key Findings** — organised thematically, using the verified claims
  4. **Analysis & Implications** — what the evidence means, patterns, trends
  5. **Contested Points & Limitations** — explicitly note where sources disagree or evidence is weak (mark with ⚠️)
  6. **Conclusion** — synthesis of findings with confidence caveats
  7. **Sources** — numbered list: [n] Title — URL
- Use tables or bullet lists where they improve clarity.
- If the sources don't fully answer the query, say so clearly rather than speculating.
- Aim for a thorough, authoritative report (600-1200 words is appropriate for complex topics).${claimSection}`

  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: `Research query: ${query}\n\nSOURCES:\n${sourceBlock}` },
  ]

  const sanitizer = makeStreamSanitizer((text) => ctx.emit({ type: 'delta', step, text }))
  const turn = await streamTurn({
    client,
    model,
    messages,
    maxTokens: agentConfig.maxSynthesisTokens,
    signal: ctx.signal,
    onDelta: (text) => sanitizer.push(text),
  })
  sanitizer.flush()
  return sanitizeText(turn.content)
}

// ---------------------------------------------------------------------------
// Main orchestrator
// ---------------------------------------------------------------------------
export async function runDeepResearch(opts: DeepResearchOptions): Promise<DeepResearchResult> {
  const { ctx, query } = opts
  const model = resolveModel(opts.provider, opts.model)
  const client = createClient(opts.provider, opts.apiKey, opts.baseUrl)
  const maxQueries = opts.maxQueries ?? agentConfig.research.maxQueries
  const maxSources = opts.maxSources ?? agentConfig.research.maxSources
  const perSourceChars = agentConfig.research.perSourceChars

  let step = 0

  // ── Phase 1: Plan ──────────────────────────────────────────────────────────
  ctx.emit({ type: 'warming', message: 'Planning research angles…' })
  const queries = await planQueries(client, model, query, maxQueries)

  ctx.emit({
    type: 'tool_call',
    step,
    name: 'plan',
    args: { queries },
  })
  ctx.emit({
    type: 'tool_result',
    step,
    name: 'plan',
    content: `Planned ${queries.length} diverse search angles:\n${queries.map((q) => '• ' + q).join('\n')}`,
  })
  step++

  // ── Phase 2: Search ─────────────────────────────────────────────────────────
  ctx.emit({ type: 'warming', message: `Searching across ${queries.length} angles…` })
  const resultsPerQuery = Math.ceil(maxSources / queries.length) + 2 // overshoot for dedup loss
  const hits = await runSearchPhase(queries, Math.min(resultsPerQuery, 8), step, ctx)
  step += queries.length

  // ── Follow-up search if initial hits are thin ───────────────────────────────
  if (hits.length < 6) {
    ctx.emit({ type: 'warming', message: 'Initial results sparse — running targeted follow-up searches…' })
    const followUps = [`"${query}" site:wikipedia.org OR site:britannica.com`, `${query} analysis report 2024 2025`]
    const extras = await runSearchPhase(followUps, 5, step, ctx)
    const seen = new Set(hits.map((h) => h.url))
    for (const r of extras) {
      if (!seen.has(r.url)) { seen.add(r.url); hits.push(r) }
    }
    step += followUps.length
  }

  // ── Phase 3: Fetch sources ──────────────────────────────────────────────────
  if (hits.length === 0) {
    const msg =
      '## Deep Research — No Sources Found\n\n' +
      'Web search returned 0 results for this query. This can happen when:\n\n' +
      '- The web search service is temporarily unavailable\n' +
      '- The query contains terms that are being filtered\n' +
      '- Network connectivity to search providers is limited in this environment\n\n' +
      '**What you can do:**\n' +
      '- Try rephrasing your query and running `/research` again\n' +
      '- Use the regular agent mode (no `/research` prefix) — it can search the web too\n' +
      '- Ask the administrator to configure a `TAVILY_API_KEY` for reliable web search\n'
    ctx.emit({ type: 'delta', step, text: msg })
    ctx.emit({ type: 'final', content: msg, metadata: sanitizeMetadata({ mode: 'research', sources: [] }) })
    return { content: msg, sources: [] }
  }

  ctx.emit({ type: 'warming', message: `Reading top ${Math.min(hits.length, maxSources)} sources…` })
  const sources = await fetchPhase(hits, maxSources, perSourceChars, step, ctx)
  step += sources.length

  // ── Phase 4: Claim verification ─────────────────────────────────────────────
  ctx.emit({ type: 'warming', message: 'Extracting and cross-verifying claims…' })
  const claims = await extractAndVerifyClaims(client, model, query, sources, step, ctx)
  step++

  // ── Phase 5: Synthesis ──────────────────────────────────────────────────────
  const finalContent = await synthesizePhase(
    client,
    model,
    query,
    sources,
    claims,
    perSourceChars,
    step,
    ctx
  )

  const citations = sources.map((s) => ({ index: s.index, title: s.title, url: s.url }))
  ctx.emit({
    type: 'final',
    content: finalContent,
    metadata: sanitizeMetadata({ mode: 'research', sources: citations }),
  })
  return { content: finalContent, sources: citations }
}
