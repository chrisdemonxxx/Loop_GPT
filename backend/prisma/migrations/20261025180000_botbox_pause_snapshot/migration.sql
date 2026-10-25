-- Computer sleep records when the operator paused the desktop.
-- Reset boots from the baseline snapshot captured on the first healthy boot.
ALTER TABLE "BotBox" ADD COLUMN "pausedAt" TIMESTAMP(3),
ADD COLUMN "lastSnapshotId" TEXT;
