-- pgvector ANN search for project knowledge (GAP-028).
-- Resilient: if the `vector` extension is unavailable on the target Postgres,
-- the extension/column/index are skipped and the app falls back to in-app
-- cosine similarity over the jsonb embedding copy.

DO $$ BEGIN
  CREATE EXTENSION IF NOT EXISTS vector;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pgvector extension unavailable: %', SQLERRM;
END $$;

DO $$ BEGIN
  ALTER TABLE "KnowledgeChunk" ADD COLUMN IF NOT EXISTS "embeddingVec" vector(1024);
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'embeddingVec column skipped: %', SQLERRM;
END $$;

DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS "KnowledgeChunk_embeddingVec_idx"
    ON "KnowledgeChunk" USING ivfflat ("embeddingVec" vector_cosine_ops) WITH (lists = 100);
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'embeddingVec index skipped: %', SQLERRM;
END $$;
