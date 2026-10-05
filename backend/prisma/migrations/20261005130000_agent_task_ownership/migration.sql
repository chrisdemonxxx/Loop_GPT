-- Bot computer (user-facing seam, B1): task ownership. An AgentTask now names
-- the account it executes as (workspace, memory, credits, live view); NULL
-- userId = system task (service account, admin-enqueued — back-compat with the
-- Phase-1 queue). Additive columns + one index; existing rows stay system tasks.

ALTER TABLE "AgentTask" ADD COLUMN "userId" TEXT;
ALTER TABLE "AgentTask" ADD COLUMN "conversationId" TEXT;
CREATE INDEX "AgentTask_userId_status_idx" ON "AgentTask"("userId", "status");
ALTER TABLE "AgentTask"
  ADD CONSTRAINT "AgentTask_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
