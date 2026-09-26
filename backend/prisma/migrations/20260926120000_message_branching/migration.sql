-- Message branching (audit SS8-22): explicit <2/3> version arrows.
-- Additive tree columns + backfill so existing conversations keep working:
--   Message.parentId        = the row each message follows in its branch
--   Conversation.activeLeafId = tip of the active path (context + transcript)
-- Regenerated answers / edited prompts become SIBLINGS (same parentId) from
-- the day this ships; pre-existing rows are chained in chronological order,
-- which is exactly the linear history they already represent.

-- 1) Columns
ALTER TABLE "Message" ADD COLUMN "parentId" TEXT;
CREATE INDEX "Message_parentId_idx" ON "Message"("parentId");
ALTER TABLE "Conversation" ADD COLUMN "activeLeafId" TEXT;

-- 2) Backfill the parent chain: each row follows the chronologically
--    previous row of the same conversation (id as the deterministic tiebreak).
WITH "ordered" AS (
  SELECT "id", "conversationId",
         LAG("id") OVER (PARTITION BY "conversationId" ORDER BY "createdAt", "id") AS "prevId"
  FROM "Message"
)
UPDATE "Message" m SET "parentId" = o."prevId"
FROM "ordered" o
WHERE m."id" = o."id" AND o."prevId" IS NOT NULL;

-- 3) Active leaf: the newest row of every conversation with messages.
UPDATE "Conversation" c SET "activeLeafId" = newest."id"
FROM (
  SELECT DISTINCT ON ("conversationId") "id", "conversationId"
  FROM "Message"
  ORDER BY "conversationId", "createdAt" DESC, "id" DESC
) newest
WHERE newest."conversationId" = c."id";
