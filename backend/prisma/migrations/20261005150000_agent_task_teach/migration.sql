-- Bot computer (teach mode): AgentTask.skillId links a task to the skill that
-- serves as its operating procedure (teach-distilled or picked). Additive.

ALTER TABLE "AgentTask" ADD COLUMN "skillId" TEXT;
