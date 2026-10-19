-- Additive: per-key limits, outbound webhooks, subscription credit bucket, workspace wallet, BatchJob, and AbuseReport.
ALTER TABLE "ApiKey" ADD COLUMN IF NOT EXISTS "spendCapMicros" BIGINT;
ALTER TABLE "ApiKey" ADD COLUMN IF NOT EXISTS "concurrencyLimit" INTEGER;
ALTER TABLE "ApiKey" ADD COLUMN IF NOT EXISTS "webhookUrl" TEXT;
ALTER TABLE "ApiKey" ADD COLUMN IF NOT EXISTS "webhookSecret" TEXT;

ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "subCreditsMicros" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "subCreditsExpireAt" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "ageVerifiedAt" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "ageVerificationProvider" TEXT;

ALTER TABLE "Workspace" ADD COLUMN IF NOT EXISTS "walletMicros" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "Workspace" ADD COLUMN IF NOT EXISTS "subCreditsMicros" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "Workspace" ADD COLUMN IF NOT EXISTS "subCreditsExpireAt" TIMESTAMP(3);
ALTER TABLE "Workspace" ADD COLUMN IF NOT EXISTS "plan" TEXT NOT NULL DEFAULT 'free';
ALTER TABLE "Workspace" ADD COLUMN IF NOT EXISTS "stripeCustomerId" TEXT;
ALTER TABLE "Workspace" ADD COLUMN IF NOT EXISTS "stripeSubId" TEXT;

ALTER TABLE "WorkspaceMember" ADD COLUMN IF NOT EXISTS "spendCapMicros" BIGINT;

CREATE TABLE IF NOT EXISTS "BatchJob" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "apiKeyId" TEXT,
    "endpoint" TEXT NOT NULL DEFAULT '/v1/chat/completions',
    "completionWindow" TEXT NOT NULL DEFAULT '24h',
    "status" TEXT NOT NULL DEFAULT 'validating',
    "totalCount" INTEGER NOT NULL DEFAULT 0,
    "completedCount" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "requestsJson" JSONB NOT NULL DEFAULT '[]',
    "resultsJson" JSONB,
    "error" TEXT,
    "costMicros" BIGINT NOT NULL DEFAULT 0,
    "reservationId" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "BatchJob_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "BatchJob_userId_createdAt_idx" ON "BatchJob"("userId", "createdAt");
CREATE INDEX IF NOT EXISTS "BatchJob_status_createdAt_idx" ON "BatchJob"("status", "createdAt");

DO $$ BEGIN
  ALTER TABLE "BatchJob" ADD CONSTRAINT "BatchJob_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "BatchJob" ADD CONSTRAINT "BatchJob_apiKeyId_fkey" FOREIGN KEY ("apiKeyId") REFERENCES "ApiKey"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "AbuseReport" (
    "id" TEXT NOT NULL,
    "reporterUserId" TEXT,
    "reporterEmail" TEXT,
    "category" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "slaDueAt" TIMESTAMP(3) NOT NULL,
    "resolvedAt" TIMESTAMP(3),
    "resolutionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AbuseReport_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "AbuseReport_status_slaDueAt_idx" ON "AbuseReport"("status", "slaDueAt");
CREATE INDEX IF NOT EXISTS "AbuseReport_targetType_targetId_idx" ON "AbuseReport"("targetType", "targetId");

DO $$ BEGIN
  ALTER TABLE "AbuseReport" ADD CONSTRAINT "AbuseReport_reporterUserId_fkey" FOREIGN KEY ("reporterUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
