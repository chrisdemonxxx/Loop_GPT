-- Paired browser on a bot task, stored beside the dedicated-computer JSON.
ALTER TABLE "AgentTask" ADD COLUMN "browser" JSONB;
