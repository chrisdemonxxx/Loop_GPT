-- Schema reconciliation (2026-09-26): brings the migration history into
-- exact agreement with schema.prisma. Drift accumulated because relation
-- onDelete/onDelete semantics and @@index removals were edited in
-- schema.prisma without regenerating migrations. Discovered by the CI
-- "Verify migration matches schema" gate, which has been failing since
-- 2026-09-21 (the step predates this fix; every push since then was red).
--
-- Deliberately does NOT touch KnowledgeChunk.embeddingVec: that column is
-- installed conditionally by 20260923020000_pgvector when the pgvector
-- extension exists (production and plain-postgres CI both take the
-- RAISE NOTICE skip path, which is expected).

-- FKs whose ON DELETE / ON UPDATE semantics exist in the schema but not in
-- the original migrations.
ALTER TABLE "Conversation" DROP CONSTRAINT "Conversation_projectId_fkey";
ALTER TABLE "KnowledgeChunk" DROP CONSTRAINT "KnowledgeChunk_projectId_fkey";

-- Indexes removed from schema.prisma but still created by old migrations.
DROP INDEX "Conversation_incognito_idx";
DROP INDEX "DailyReservation_userId_windowStart_idx";
DROP INDEX "DailyReservation_windowStart_idx";
DROP INDEX "ResearchScratchpad_userId_idx";

-- SpendBudgetPolicy caps lost their schema defaults; drop the stale ones.
ALTER TABLE "SpendBudgetPolicy" ALTER COLUMN "perUserDailyReservationCap" DROP DEFAULT;
ALTER TABLE "SpendBudgetPolicy" ALTER COLUMN "globalDailyReservationCap" DROP DEFAULT;

ALTER TABLE "KnowledgeChunk" ADD CONSTRAINT "KnowledgeChunk_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Project" ADD CONSTRAINT "Project_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Memory" ADD CONSTRAINT "Memory_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Memory" ADD CONSTRAINT "Memory_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "UserStyle" ADD CONSTRAINT "UserStyle_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;
