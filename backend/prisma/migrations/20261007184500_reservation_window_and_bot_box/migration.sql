-- Additive: speed up daily-reservation admission counts, and remember a
-- user's persistent computer box so a restarted worker can reconnect.

CREATE INDEX "DailyReservation_windowStart_idx" ON "DailyReservation"("windowStart");

CREATE TABLE "BotBox" (
    "userId" TEXT NOT NULL,
    "sandboxId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BotBox_pkey" PRIMARY KEY ("userId")
);

ALTER TABLE "BotBox" ADD CONSTRAINT "BotBox_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
