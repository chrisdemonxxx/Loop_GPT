-- Additive Loop-IT links. Nullable so existing rows stay valid and nothing is backfilled.

ALTER TABLE "Workspace" ADD COLUMN "loopitOrgId" TEXT;

ALTER TABLE "Project" ADD COLUMN "loopitProjectId" TEXT;

ALTER TABLE "Conversation" ADD COLUMN "loopitRunId" TEXT;
