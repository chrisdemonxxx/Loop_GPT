-- Bot computer (Phase 3): dedicated-computer session metadata + cross-process
-- takeover flag on BotRun. Additive columns; no changes to existing rows.

ALTER TABLE "BotRun" ADD COLUMN "computer" JSONB;
ALTER TABLE "BotRun" ADD COLUMN "takeoverRequested" BOOLEAN NOT NULL DEFAULT false;
