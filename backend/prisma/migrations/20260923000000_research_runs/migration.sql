-- Durable deep-research runs (GAP-017/018): progress + final cited report.
CREATE TABLE "ResearchRun" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "query" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "events" JSONB NOT NULL,
    "report" TEXT,
    "sources" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ResearchRun_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ResearchRun_userId_conversationId_idx" ON "ResearchRun"("userId", "conversationId");
ALTER TABLE "ResearchRun" ADD CONSTRAINT "ResearchRun_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
