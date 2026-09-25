-- Sidebar parity (audit §8-13/14/15): pinned conversations and public
-- read-only share tokens. Both additive; shareToken is nullable and unique
-- (multiple NULLs are allowed by PostgreSQL).

ALTER TABLE "Conversation" ADD COLUMN "pinned" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Conversation" ADD COLUMN "shareToken" TEXT;
CREATE UNIQUE INDEX "Conversation_shareToken_key" ON "Conversation"("shareToken");
