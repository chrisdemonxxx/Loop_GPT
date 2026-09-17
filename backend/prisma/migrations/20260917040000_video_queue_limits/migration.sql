-- Apply with video workers stopped for the schema upgrade; limits are subsequently
-- DB-admin configured without worker restarts. No per-process capacity settings.
CREATE TABLE "VideoQueuePolicy" (
  "id" INTEGER PRIMARY KEY DEFAULT 1 CHECK ("id" = 1),
  "version" INTEGER NOT NULL DEFAULT 1 CHECK ("version" = 1),
  "revision" INTEGER NOT NULL DEFAULT 1 CHECK ("revision" > 0),
  "globalOutstanding" INTEGER NOT NULL DEFAULT 64 CHECK ("globalOutstanding" BETWEEN 1 AND 10000),
  "userOutstanding" INTEGER NOT NULL DEFAULT 8 CHECK ("userOutstanding" BETWEEN 1 AND 1000),
  "globalActive" INTEGER NOT NULL DEFAULT 8 CHECK ("globalActive" BETWEEN 1 AND 1000),
  "userActive" INTEGER NOT NULL DEFAULT 2 CHECK ("userActive" BETWEEN 1 AND 100),
  CHECK ("userOutstanding" <= "globalOutstanding" AND "userActive" <= "globalActive"
    AND "globalActive" <= "globalOutstanding" AND "userActive" <= "userOutstanding")
);
INSERT INTO "VideoQueuePolicy" ("id") VALUES (1);
ALTER TABLE "AccountedVideoJob" ADD COLUMN "upstreamSlot" BOOLEAN NOT NULL DEFAULT false;
-- Conservative backfill: cancelled MediaJob status is NOT upstream completion.
-- Existing confirmed terminal job states are safe; all uncertain work retains a slot.
UPDATE "AccountedVideoJob" SET "upstreamSlot" = true
WHERE "state" NOT IN ('completed', 'cancelled') AND
  ("submittedAt" IS NOT NULL OR "state" IN ('submitting', 'polling', 'settling', 'needs_reconciliation'));
CREATE INDEX "AccountedVideoJob_upstreamSlot_idx" ON "AccountedVideoJob" ("upstreamSlot");
-- Older dispatch writers cannot introduce uncounted upstream work after upgrade.
-- A slot may be acquired while still queued inside the dispatch transaction, but
-- submitted/uncertain stages may NEVER clear it, even if their lease has expired.
ALTER TABLE "AccountedVideoJob" ADD CONSTRAINT "video_upstream_slot" CHECK (
  "upstreamSlot" OR ("state" NOT IN ('submitting', 'polling', 'settling', 'needs_reconciliation')
    AND ("submittedAt" IS NULL OR "state" IN ('completed', 'cancelled')))
);
