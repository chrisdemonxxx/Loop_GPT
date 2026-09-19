-- Durable Stripe event inbox for exactly-once webhook fulfillment.
CREATE TABLE "StripeEventInbox" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "errorCount" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "payloadJson" TEXT NOT NULL,
    CONSTRAINT "StripeEventInbox_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "StripeEventInbox_eventId_key" ON "StripeEventInbox"("eventId");
