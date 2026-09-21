-- Projects + knowledge base (GAP-019)
CREATE TABLE "Project" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "instructions" TEXT NOT NULL DEFAULT '',
    "role" TEXT NOT NULL DEFAULT 'viewer',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Project_workspaceId_idx" ON "Project"("workspaceId");

ALTER TABLE "Conversation" ADD COLUMN "projectId" TEXT;
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL;

-- Recreate KnowledgeChunk with projectId instead of userId
DROP TABLE IF EXISTS "KnowledgeChunk";
CREATE TABLE "KnowledgeChunk" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "embedding" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "KnowledgeChunk_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "KnowledgeChunk_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE
);
CREATE INDEX "KnowledgeChunk_projectId_idx" ON "KnowledgeChunk"("projectId");
