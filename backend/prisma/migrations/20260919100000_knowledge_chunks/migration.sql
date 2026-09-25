-- KnowledgeChunk table (GAP-007 foundation).
-- Embeddings are stored as jsonb so the schema works without pgvector.
-- When pgvector is available, change to "embedding" vector(1024).

CREATE TABLE "KnowledgeChunk" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "conversationId" TEXT,
    "content" TEXT NOT NULL,
    "embedding" jsonb,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "KnowledgeChunk_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "KnowledgeChunk_userId_idx" ON "KnowledgeChunk"("userId");
