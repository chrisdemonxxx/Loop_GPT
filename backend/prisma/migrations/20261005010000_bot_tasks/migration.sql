-- Bot computer (Phase 1): durable autonomous agent task queue + run records.
-- Two additive tables; no changes to existing rows or constraints. The bot
-- worker claims AgentTask rows with the same DB-clock lease pattern as the
-- settlement workers (SKIP LOCKED, guarded acknowledgements).

CREATE TABLE "AgentTask" (
  "id" TEXT NOT NULL,
  "kind" TEXT NOT NULL DEFAULT 'ops',
  "goal" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'queued',
  "schedule" TEXT,
  "model" TEXT,
  "thinking" TEXT,
  "allowedTools" JSONB,
  "maxSteps" INTEGER,
  "computer" JSONB,
  "priority" INTEGER NOT NULL DEFAULT 0,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "failures" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "leaseToken" TEXT,
  "leaseExpiresAt" TIMESTAMP(3),
  "cancelRequested" BOOLEAN NOT NULL DEFAULT false,
  "lastErrorCode" TEXT,
  "lastError" TEXT,
  "createdBy" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "AgentTask_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AgentTask_status_nextAttemptAt_idx" ON "AgentTask"("status", "nextAttemptAt");
CREATE INDEX "AgentTask_leaseExpiresAt_idx" ON "AgentTask"("leaseExpiresAt");
CREATE INDEX "AgentTask_priority_nextAttemptAt_idx" ON "AgentTask"("priority", "nextAttemptAt");

CREATE TABLE "BotRun" (
  "id" TEXT NOT NULL,
  "taskId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'running',
  "events" JSONB NOT NULL DEFAULT '[]',
  "result" TEXT,
  "artifacts" JSONB,
  "usage" JSONB,
  "error" TEXT,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),

  CONSTRAINT "BotRun_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "BotRun_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "AgentTask"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "BotRun_taskId_idx" ON "BotRun"("taskId");
CREATE INDEX "BotRun_status_idx" ON "BotRun"("status");
