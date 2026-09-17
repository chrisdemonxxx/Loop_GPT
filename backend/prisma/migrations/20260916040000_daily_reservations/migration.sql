CREATE TYPE "DailyReservationState" AS ENUM ('reserved', 'dispatched', 'unknown', 'captured', 'released');
CREATE TABLE "DailyReservation" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "model" TEXT NOT NULL,
  "credits" INTEGER NOT NULL CHECK ("credits" >= 0),
  "imageCredits" INTEGER NOT NULL CHECK ("imageCredits" >= 0),
  "bypass" BOOLEAN NOT NULL,
  "windowStart" TIMESTAMP(3) NOT NULL,
  "state" "DailyReservationState" NOT NULL DEFAULT 'reserved',
  "settlementFingerprint" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "DailyReservation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "DailyReservation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "DailyReservation_userId_createdAt_idx" ON "DailyReservation"("userId", "createdAt");
CREATE INDEX "DailyReservation_state_updatedAt_idx" ON "DailyReservation"("state", "updatedAt");
ALTER TABLE "UsageEvent" ADD COLUMN "reservationId" TEXT;
CREATE UNIQUE INDEX "UsageEvent_reservationId_key" ON "UsageEvent"("reservationId");
ALTER TABLE "UsageEvent" ADD CONSTRAINT "UsageEvent_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "DailyReservation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
