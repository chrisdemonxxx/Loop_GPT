-- Additive: historical media rows are deliberately not backfilled or dispatched.
CREATE TABLE "AccountedVideoJob" (
  "jobId" TEXT PRIMARY KEY REFERENCES "MediaJob"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "reservationId" TEXT NOT NULL UNIQUE REFERENCES "ApiReservation"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "endpoint" TEXT NOT NULL,
  "config" JSONB NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'queued',
  "submittedAt" TIMESTAMP(3),
  "cancelRequested" BOOLEAN NOT NULL DEFAULT false,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "failures" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "leaseToken" TEXT,
  "leaseExpiresAt" TIMESTAMP(3),
  "stagedArtifact" JSONB,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "video_state" CHECK ("state" IN ('queued','submitting','polling','settling','completed','cancelled','needs_reconciliation')),
  CONSTRAINT "video_attempts" CHECK ("attempts" BETWEEN 0 AND 1001 AND "failures" BETWEEN 0 AND 10),
  CONSTRAINT "video_lease" CHECK (("leaseToken" IS NULL) = ("leaseExpiresAt" IS NULL)),
  CONSTRAINT "video_submit" CHECK (("state" != 'queued' OR "submittedAt" IS NULL) AND
    ("state" NOT IN ('submitting','polling','settling','completed') OR "submittedAt" IS NOT NULL)),
  CONSTRAINT "video_evidence" CHECK ("state" NOT IN ('settling','completed') OR "stagedArtifact" IS NOT NULL)
);
CREATE INDEX "AccountedVideoJob_state_nextAttemptAt_idx" ON "AccountedVideoJob"("state", "nextAttemptAt");
CREATE INDEX "AccountedVideoJob_leaseExpiresAt_idx" ON "AccountedVideoJob"("leaseExpiresAt");
