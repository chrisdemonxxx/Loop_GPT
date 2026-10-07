-- Bots assigned to a project. The project room is one group conversation.

CREATE TABLE "ProjectBot" (
    "projectId" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProjectBot_pkey" PRIMARY KEY ("projectId","botId")
);

CREATE INDEX "ProjectBot_botId_idx" ON "ProjectBot"("botId");

ALTER TABLE "ProjectBot" ADD CONSTRAINT "ProjectBot_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ProjectBot" ADD CONSTRAINT "ProjectBot_botId_fkey" FOREIGN KEY ("botId") REFERENCES "Bot"("id") ON DELETE CASCADE ON UPDATE CASCADE;
