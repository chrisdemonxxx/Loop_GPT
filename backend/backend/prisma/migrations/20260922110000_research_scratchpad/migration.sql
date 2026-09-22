-- Research scratchpad (GAP-046): durable per-phase deep-research state so
-- interrupted runs resume from the last completed phase. 24h TTL enforced in app.
CREATE TABLE "ResearchScratchpad" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "queryHash" TEXT NOT NULL,
    "query" TEXT NOT NULL,
    "queries" JSONB,
    "hits" JSONB,
    "sources" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ResearchScratchpad_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ResearchScratchpad_userId_queryHash_key" ON "ResearchScratchpad"("userId", "queryHash");
CREATE INDEX "ResearchScratchpad_userId_idx" ON "ResearchScratchpad"("userId");
ALTER TABLE "ResearchScratchpad" ADD CONSTRAINT "ResearchScratchpad_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

