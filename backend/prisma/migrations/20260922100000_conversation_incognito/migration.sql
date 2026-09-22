-- Incognito chats (brief 2.5): excluded from the sidebar, memory synthesis,
-- and memory injection. Deleted when the user closes the conversation.
ALTER TABLE "Conversation" ADD COLUMN "incognito" BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX "Conversation_incognito_idx" ON "Conversation"("incognito");

