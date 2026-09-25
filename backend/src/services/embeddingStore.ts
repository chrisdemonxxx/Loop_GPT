/**
 * Embedding + reranker + pgvector search (GAP-007).
 *
 * Uses BAAI/bge-m3 for embeddings (1024-d) and bge-reranker-v2-m3 for reranking,
 * both through the serverless HF Inference API (no dedicated endpoint required).
 * The HF_TOKEN must be set.
 */

const HF_TOKEN = process.env.HF_TOKEN

// The HF router is the current serverless path; api-inference is the legacy
// host kept as a fallback for feature-extraction.
const ROUTER = 'https://router.huggingface.co/hf-inference/models'

async function postJson(url: string, body: unknown): Promise<any> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${HF_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) {
    const txt = await res.text().catch(() => '')
    throw new Error(`Inference API error ${res.status}: ${txt.slice(0, 200)}`)
  }
  return res.json()
}

async function inference(mode: 'embed' | 'rerank', body: unknown): Promise<any> {
  if (!HF_TOKEN) throw new Error('HF_TOKEN required for embeddings')
  const model = mode === 'embed' ? 'BAAI/bge-m3' : 'BAAI/bge-reranker-v2-m3'
  const pipeline = mode === 'embed' ? 'feature-extraction' : 'rerank'
  try {
    return await postJson(`${ROUTER}/${model}/pipeline/${pipeline}`, body)
  } catch (error) {
    // Legacy host fallback (feature-extraction only; rerank shape differs).
    if (mode === 'embed') return postJson(`https://api-inference.huggingface.co/pipeline/feature-extraction/${model}`, body)
    throw error
  }
}

/** Embed a single text string. Returns a 1024‑dim float array. */
export async function embedText(text: string): Promise<number[]> {
  const result = await inference('embed', { inputs: text })
  // bge-m3 returns a flat array for a single input.
  return Array.isArray(result[0]) ? result[0] : result
}

/** Embed multiple texts in one call. Returns arrays, cheapest in a single call. */
export async function embedTexts(texts: string[]): Promise<number[][]> {
  const result = await inference('embed', { inputs: texts })
  return result as number[][]
}

/** Reranker: returns scored results for a query against candidate docs. */
export interface RerankResult { score: number; text: string; index: number }

/** Accept the common reranker response shapes and normalize to {score,index}. */
function normalizeRerank(raw: any, docs: string[]): RerankResult[] | null {
  if (!Array.isArray(raw)) return null
  const out: RerankResult[] = []
  raw.forEach((item: any, i: number) => {
    if (item && typeof item.score === 'number') {
      const index = Number.isInteger(item.index) ? item.index : i
      if (docs[index] !== undefined) out.push({ score: item.score, text: docs[index], index })
    }
  })
  return out.length ? out : null
}

export async function rerank(query: string, docs: string[]): Promise<RerankResult[]> {
  // The router's ranking pipeline has changed shape across versions; try the
  // documented variants and normalize whichever answers.
  const shapes = [
    { inputs: { source_sentence: query, sentences: docs } },
    { inputs: { query, texts: docs } },
    { inputs: query, parameters: { candidates: docs } },
  ]
  for (const body of shapes) {
    try {
      const normalized = normalizeRerank(await inference('rerank', body), docs)
      if (normalized) return normalized
    } catch { /* try the next shape */ }
  }
  throw new Error('rerank unavailable')
}

/** Generate an embedding vector using bge-m3 with the prescribed prefix. */
export async function generateEmbedding(text: string): Promise<number[]> {
  return embedText(text)
}
