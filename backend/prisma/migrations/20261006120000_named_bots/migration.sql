-- Named bots, per-bot threads, and group chats.
-- Existing conversations stay kind='chat' with a null botId.
-- Existing agent tasks keep a null botId until a primary Loop Bot exists.

CREATE TABLE "Bot" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "label" TEXT NOT NULL DEFAULT '',
    "avatarColor" TEXT NOT NULL DEFAULT '#c96442',
    "persona" TEXT NOT NULL DEFAULT '',
    "defaultTools" JSONB,
    "cloudComputer" BOOLEAN NOT NULL DEFAULT false,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Bot_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Bot_ownerId_idx" ON "Bot"("ownerId");
CREATE INDEX "Bot_ownerId_isPrimary_idx" ON "Bot"("ownerId", "isPrimary");

ALTER TABLE "Bot" ADD CONSTRAINT "Bot_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Conversation" ADD COLUMN "botId" TEXT;
ALTER TABLE "Conversation" ADD COLUMN "botIds" JSONB;
ALTER TABLE "Conversation" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'chat';

CREATE INDEX "Conversation_botId_idx" ON "Conversation"("botId");
CREATE INDEX "Conversation_userId_kind_idx" ON "Conversation"("userId", "kind");

ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_botId_fkey" FOREIGN KEY ("botId") REFERENCES "Bot"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "AgentTask" ADD COLUMN "botId" TEXT;
CREATE INDEX "AgentTask_botId_idx" ON "AgentTask"("botId");
ALTER TABLE "AgentTask" ADD CONSTRAINT "AgentTask_botId_fkey" FOREIGN KEY ("botId") REFERENCES "Bot"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Message" ADD COLUMN "authorBotId" TEXT;
