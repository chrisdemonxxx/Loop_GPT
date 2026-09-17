CREATE TYPE "ApiSettlementStatus" AS ENUM ('pending', 'processing', 'succeeded', 'conflict', 'dead_letter');

-- Additive only: historical reservations, usage, and settlement references stay intact.
CREATE TABLE "ApiSettlementIntent" (
  "reservationId" TEXT PRIMARY KEY REFERENCES "ApiReservation"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "userId" TEXT NOT NULL,
  "apiKeyId" TEXT,
  "kind" TEXT NOT NULL,
  "model" TEXT NOT NULL,
  "costMicros" BIGINT NOT NULL CHECK ("costMicros" BETWEEN 0 AND 9007199254740991),
  "tokensIn" INTEGER NOT NULL CHECK ("tokensIn" >= 0),
  "tokensOut" INTEGER NOT NULL CHECK ("tokensOut" >= 0),
  "units" INTEGER NOT NULL CHECK ("units" >= 0),
  "fingerprint" TEXT NOT NULL,
  "reconciliationReference" TEXT NOT NULL,
  "status" "ApiSettlementStatus" NOT NULL DEFAULT 'pending',
  "attempts" INTEGER NOT NULL DEFAULT 0 CHECK ("attempts" BETWEEN 0 AND 11),
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "leaseToken" TEXT,
  "leaseExpiresAt" TIMESTAMP(3),
  "lastErrorCode" VARCHAR(64),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "api_intent_identity" CHECK (
    length(btrim("reservationId")) > 0 AND length("reservationId") <= 256 AND
    length(btrim("userId")) > 0 AND length("userId") <= 256 AND
    ("apiKeyId" IS NULL OR (length(btrim("apiKeyId")) > 0 AND length("apiKeyId") <= 256)) AND
    "kind" IN ('chat', 'embedding', 'image', 'video') AND
    length(btrim("model")) > 0 AND length("model") <= 256 AND
    "fingerprint" ~ '^[a-f0-9]{64}$' AND
    "reconciliationReference" = 'server:api-settlement:' || "fingerprint"
  ),
  CONSTRAINT "api_intent_lease" CHECK (
    ("status" = 'processing' AND "leaseToken" IS NOT NULL AND "leaseExpiresAt" IS NOT NULL) OR
    ("status" <> 'processing' AND "leaseToken" IS NULL AND "leaseExpiresAt" IS NULL)
  )
);
CREATE INDEX "ApiSettlementIntent_status_nextAttemptAt_idx" ON "ApiSettlementIntent"("status", "nextAttemptAt");
CREATE INDEX "ApiSettlementIntent_status_leaseExpiresAt_idx" ON "ApiSettlementIntent"("status", "leaseExpiresAt");

CREATE FUNCTION api_settlement_intent_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW."reservationId", NEW."userId", NEW."apiKeyId", NEW."kind", NEW."model", NEW."costMicros",
         NEW."tokensIn", NEW."tokensOut", NEW."units", NEW."fingerprint", NEW."reconciliationReference", NEW."createdAt")
     IS DISTINCT FROM
     ROW(OLD."reservationId", OLD."userId", OLD."apiKeyId", OLD."kind", OLD."model", OLD."costMicros",
         OLD."tokensIn", OLD."tokensOut", OLD."units", OLD."fingerprint", OLD."reconciliationReference", OLD."createdAt") THEN
    RAISE EXCEPTION 'Immutable API settlement intent' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER api_settlement_intent_immutable BEFORE UPDATE ON "ApiSettlementIntent"
  FOR EACH ROW EXECUTE FUNCTION api_settlement_intent_immutable();
