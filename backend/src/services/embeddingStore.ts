/**
 * Embedding + reranker + pgvector search (GAP-007).
 *
 * Uses BAAI/bge-m3 for embeddings (1024-d) and bge-reranker-v2-m3 for reranking,
 * both through the serverless HF Inference API (no dedicated endpoint required).
 * The HF_TOKEN must be set.
 */

const HF_TOKEN = process.env.HF_TOKEN

async function inference(mode: 'embed' | 'rerank', body: unknown): Promise<any> {
  if (!HF_TOKEN) throw new Error('HF_TOKEN required for embeddings')
  const model = mode === 'embed' ? 'BAAI/bge-m3' : 'BAAI/bge-reranker-v2-m3'
  const endpoint = `https://api-inference.huggingface.co/pipeline/${mode === 'embed' ? 'feature-extraction' : 'rerank'}/${model}`
  const res = await fetch(endpoint, {
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
export async function rerank(query: string, docs: string[]): Promise<RerankResult[]> {
  const result = await inference('rerank', { query, texts: docs })
  return result as RerankResult[]
}

/** Generate an embedding vector using bge-m3 with the prescribed prefix. */
export async function generateEmbedding(text: string): Promise<number[]> {
  return embedText(text)
}
