CREATE TYPE "ApiReservationState" AS ENUM ('reserved', 'dispatched', 'unknown', 'captured', 'released');
CREATE UNIQUE INDEX "ApiKey_id_userId_key" ON "ApiKey"("id", "userId");
CREATE INDEX "ApiTopUp_source_reference_idx" ON "ApiTopUp"("source", "reference");
CREATE TABLE "ApiReservation" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "apiKeyId" TEXT,
  "kind" TEXT NOT NULL,
  "model" TEXT NOT NULL,
  "amountMicros" BIGINT NOT NULL CHECK ("amountMicros" BETWEEN 0 AND 9007199254740991),
  "requestFingerprint" TEXT NOT NULL,
  "pricingSnapshot" JSONB,
  "state" "ApiReservationState" NOT NULL DEFAULT 'reserved',
  "settlementFingerprint" TEXT,
  "capturedMicros" BIGINT CHECK ("capturedMicros" BETWEEN 0 AND "amountMicros"),
  "evidence" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ApiReservation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ApiReservation_apiKeyId_userId_fkey" FOREIGN KEY ("apiKeyId", "userId") REFERENCES "ApiKey"("id", "userId") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ApiReservation_settlement_check" CHECK (
    ("state" IN ('captured', 'released') AND "capturedMicros" IS NOT NULL AND "settlementFingerprint" IS NOT NULL)
    OR ("state" IN ('reserved', 'dispatched', 'unknown') AND "capturedMicros" IS NULL AND "settlementFingerprint" IS NULL)
  ),
  CONSTRAINT "ApiReservation_release_check" CHECK ("state" <> 'released' OR "capturedMicros" = 0)
);
CREATE INDEX "ApiReservation_state_updatedAt_idx" ON "ApiReservation"("state", "updatedAt");
CREATE INDEX "ApiReservation_userId_createdAt_idx" ON "ApiReservation"("userId", "createdAt");
ALTER TABLE "ApiUsage" ADD COLUMN "reservationId" TEXT;
CREATE UNIQUE INDEX "ApiUsage_reservationId_key" ON "ApiUsage"("reservationId");
ALTER TABLE "ApiUsage" ADD CONSTRAINT "ApiUsage_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "ApiReservation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE TABLE "ApiCreditIdentity" (
  "source" TEXT NOT NULL,
  "reference" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "amountMicros" BIGINT NOT NULL CHECK ("amountMicros" BETWEEN 0 AND 9007199254740991),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("source", "reference")
);
-- Historical balances/top-ups are not rewritten or deduplicated. All new writes
-- use conditional balance predicates and reference identities in serializable TXs.
