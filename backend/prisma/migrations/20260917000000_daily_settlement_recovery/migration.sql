CREATE TYPE "DailySettlementStatus" AS ENUM ('pending', 'processing', 'succeeded', 'conflict', 'dead_letter');

CREATE TABLE "DailySettlementIntent" (
  "reservationId" TEXT PRIMARY KEY REFERENCES "DailyReservation"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "userId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "model" TEXT NOT NULL,
  "tokensIn" INTEGER NOT NULL,
  "tokensOut" INTEGER NOT NULL,
  "images" INTEGER NOT NULL,
  "fingerprint" TEXT NOT NULL,
  "status" "DailySettlementStatus" NOT NULL DEFAULT 'pending',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "leaseToken" TEXT,
  "leaseExpiresAt" TIMESTAMP(3),
  "lastErrorCode" VARCHAR(64),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "daily_intent_metrics" CHECK (
    "tokensIn" >= 0 AND "tokensOut" >= 0 AND "images" >= 0 AND
    "kind" IN ('chat', 'agent', 'research', 'image', 'video') AND
    "images" <= CASE WHEN "kind" = 'image' THEN 1 ELSE 0 END AND
    length("model") <= 1024 AND length("fingerprint") = 64 AND "attempts" >= 0
  ),
  CONSTRAINT "daily_intent_lease" CHECK (
    ("status" = 'processing' AND "leaseToken" IS NOT NULL AND "leaseExpiresAt" IS NOT NULL) OR
    ("status" <> 'processing' AND "leaseToken" IS NULL AND "leaseExpiresAt" IS NULL)
  )
);
CREATE INDEX "DailySettlementIntent_status_nextAttemptAt_idx" ON "DailySettlementIntent"("status", "nextAttemptAt");
CREATE INDEX "DailySettlementIntent_status_leaseExpiresAt_idx" ON "DailySettlementIntent"("status", "leaseExpiresAt");

-- Delivery updates must never overwrite the evidence accepted before capture.
CREATE FUNCTION daily_settlement_intent_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW."reservationId", NEW."userId", NEW."kind", NEW."model", NEW."tokensIn", NEW."tokensOut", NEW."images", NEW."fingerprint", NEW."createdAt")
    IS DISTINCT FROM
    ROW(OLD."reservationId", OLD."userId", OLD."kind", OLD."model", OLD."tokensIn", OLD."tokensOut", OLD."images", OLD."fingerprint", OLD."createdAt") THEN
    RAISE EXCEPTION 'Immutable daily settlement intent' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER daily_settlement_intent_immutable BEFORE UPDATE ON "DailySettlementIntent"
  FOR EACH ROW EXECUTE FUNCTION daily_settlement_intent_immutable();
