-- Baseline generated from the existing schema with Prisma migrate diff.
-- For an existing database, reconcile and baseline explicitly; never auto-resolve.
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'user',
    "unlimited" BOOLEAN NOT NULL DEFAULT false,
    "emailVerified" BOOLEAN NOT NULL DEFAULT false,
    "stripeCustomerId" TEXT,
    "stripeSubId" TEXT,
    "plan" TEXT NOT NULL DEFAULT 'free',
    "credits" INTEGER NOT NULL DEFAULT 30,
    "imageCredits" INTEGER NOT NULL DEFAULT 5,
    "creditsResetAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "consentTraining" BOOLEAN NOT NULL DEFAULT false,
    "tokensInTotal" BIGINT NOT NULL DEFAULT 0,
    "tokensOutTotal" BIGINT NOT NULL DEFAULT 0,
    "imagesTotal" INTEGER NOT NULL DEFAULT 0,
    "messagesTotal" INTEGER NOT NULL DEFAULT 0,
    "lastActiveAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "apiBalanceMicros" BIGINT NOT NULL DEFAULT 0,
    "apiPlan" TEXT,
    "apiSubId" TEXT,
    "apiPlanRenewsAt" TIMESTAMP(3),
    "apiPreviewGranted" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "ApiKey" (
    "id" TEXT NOT NULL, "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT 'Default key', "keyHash" TEXT NOT NULL,
    "prefix" TEXT NOT NULL, "revoked" BOOLEAN NOT NULL DEFAULT false,
    "lastUsedAt" TIMESTAMP(3), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ApiKey_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "ApiUsage" (
    "id" TEXT NOT NULL, "userId" TEXT NOT NULL, "apiKeyId" TEXT,
    "kind" TEXT NOT NULL, "model" TEXT NOT NULL DEFAULT '',
    "tokensIn" INTEGER NOT NULL DEFAULT 0, "tokensOut" INTEGER NOT NULL DEFAULT 0,
    "units" INTEGER NOT NULL DEFAULT 0, "costMicros" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ApiUsage_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "ApiTopUp" (
    "id" TEXT NOT NULL, "userId" TEXT NOT NULL, "amountMicros" BIGINT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'stripe', "reference" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ApiTopUp_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "Token" (
    "id" TEXT NOT NULL, "token" TEXT NOT NULL, "type" TEXT NOT NULL, "userId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL, "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Token_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "Voucher" (
    "id" TEXT NOT NULL, "code" TEXT NOT NULL, "type" TEXT NOT NULL DEFAULT 'credits', "plan" TEXT,
    "credits" INTEGER NOT NULL DEFAULT 0, "imageCredits" INTEGER NOT NULL DEFAULT 0,
    "maxRedemptions" INTEGER NOT NULL DEFAULT 1, "redemptionCount" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true, "expiresAt" TIMESTAMP(3), "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Voucher_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "VoucherRedemption" (
    "id" TEXT NOT NULL, "voucherId" TEXT NOT NULL, "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "VoucherRedemption_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "UsageEvent" (
    "id" TEXT NOT NULL, "userId" TEXT NOT NULL, "kind" TEXT NOT NULL,
    "tokensIn" INTEGER NOT NULL DEFAULT 0, "tokensOut" INTEGER NOT NULL DEFAULT 0,
    "credits" INTEGER NOT NULL DEFAULT 0, "model" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "UsageEvent_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "Payment" (
    "id" TEXT NOT NULL, "userId" TEXT NOT NULL, "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'usd', "status" TEXT NOT NULL DEFAULT 'succeeded',
    "provider" TEXT NOT NULL DEFAULT 'stripe', "reference" TEXT, "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "Conversation" (
    "id" TEXT NOT NULL, "title" TEXT NOT NULL, "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Conversation_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "Message" (
    "id" TEXT NOT NULL, "role" TEXT NOT NULL, "content" TEXT NOT NULL, "conversationId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "messageType" TEXT NOT NULL DEFAULT 'text', "imageUrl" TEXT, "imagePath" TEXT, "toolUsed" TEXT, "metadata" JSONB,
    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "MediaJob" (
    "id" TEXT NOT NULL, "userId" TEXT NOT NULL, "kind" TEXT NOT NULL DEFAULT 'video',
    "prompt" TEXT NOT NULL, "status" TEXT NOT NULL DEFAULT 'queued', "progress" INTEGER NOT NULL DEFAULT 0,
    "providerJobId" TEXT, "statusUrl" TEXT, "resultUrl" TEXT, "outputUrl" TEXT, "error" TEXT, "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3), "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "MediaJob_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");
CREATE INDEX "User_role_idx" ON "User"("role");
CREATE INDEX "User_plan_idx" ON "User"("plan");
CREATE UNIQUE INDEX "ApiKey_keyHash_key" ON "ApiKey"("keyHash");
CREATE INDEX "ApiKey_userId_idx" ON "ApiKey"("userId");
CREATE INDEX "ApiKey_keyHash_idx" ON "ApiKey"("keyHash");
CREATE INDEX "ApiUsage_userId_createdAt_idx" ON "ApiUsage"("userId", "createdAt");
CREATE INDEX "ApiUsage_apiKeyId_createdAt_idx" ON "ApiUsage"("apiKeyId", "createdAt");
CREATE INDEX "ApiTopUp_userId_createdAt_idx" ON "ApiTopUp"("userId", "createdAt");
CREATE UNIQUE INDEX "Token_token_key" ON "Token"("token");
CREATE INDEX "Token_userId_idx" ON "Token"("userId");
CREATE INDEX "Token_type_idx" ON "Token"("type");
CREATE UNIQUE INDEX "Voucher_code_key" ON "Voucher"("code");
CREATE INDEX "Voucher_active_idx" ON "Voucher"("active");
CREATE INDEX "VoucherRedemption_userId_idx" ON "VoucherRedemption"("userId");
CREATE UNIQUE INDEX "VoucherRedemption_voucherId_userId_key" ON "VoucherRedemption"("voucherId", "userId");
CREATE INDEX "UsageEvent_userId_idx" ON "UsageEvent"("userId");
CREATE INDEX "UsageEvent_createdAt_idx" ON "UsageEvent"("createdAt");
CREATE INDEX "UsageEvent_kind_idx" ON "UsageEvent"("kind");
CREATE INDEX "Payment_userId_idx" ON "Payment"("userId");
CREATE INDEX "Payment_createdAt_idx" ON "Payment"("createdAt");
CREATE INDEX "Conversation_userId_idx" ON "Conversation"("userId");
CREATE INDEX "Message_conversationId_idx" ON "Message"("conversationId");
CREATE INDEX "MediaJob_userId_createdAt_idx" ON "MediaJob"("userId", "createdAt");
CREATE INDEX "MediaJob_status_createdAt_idx" ON "MediaJob"("status", "createdAt");
ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ApiUsage" ADD CONSTRAINT "ApiUsage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ApiUsage" ADD CONSTRAINT "ApiUsage_apiKeyId_fkey" FOREIGN KEY ("apiKeyId") REFERENCES "ApiKey"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ApiTopUp" ADD CONSTRAINT "ApiTopUp_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Token" ADD CONSTRAINT "Token_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VoucherRedemption" ADD CONSTRAINT "VoucherRedemption_voucherId_fkey" FOREIGN KEY ("voucherId") REFERENCES "Voucher"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VoucherRedemption" ADD CONSTRAINT "VoucherRedemption_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "UsageEvent" ADD CONSTRAINT "UsageEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Message" ADD CONSTRAINT "Message_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MediaJob" ADD CONSTRAINT "MediaJob_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
