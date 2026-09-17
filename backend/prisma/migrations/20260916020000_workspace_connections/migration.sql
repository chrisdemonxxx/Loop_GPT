-- Additive foundation only. Existing conversations are not reassigned, and
-- legacy plaintext/global configuration is deliberately not imported.
CREATE TYPE "WorkspaceRole" AS ENUM ('owner', 'editor', 'viewer');

CREATE TABLE "Workspace" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "personalOwnerId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Workspace_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "WorkspaceMember" (
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "WorkspaceRole" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WorkspaceMember_pkey" PRIMARY KEY ("workspaceId", "userId")
);

CREATE TABLE "WorkspaceConnection" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "encryptedConfig" TEXT NOT NULL,
    "configuredFields" TEXT[],
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "WorkspaceConnection_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "WorkspaceAuditEvent" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "resourceId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WorkspaceAuditEvent_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "Conversation" ADD COLUMN "workspaceId" TEXT;
CREATE UNIQUE INDEX "Workspace_personalOwnerId_key" ON "Workspace"("personalOwnerId");
CREATE INDEX "WorkspaceMember_userId_idx" ON "WorkspaceMember"("userId");
CREATE INDEX "WorkspaceConnection_workspaceId_idx" ON "WorkspaceConnection"("workspaceId");
CREATE INDEX "WorkspaceAuditEvent_workspaceId_createdAt_idx" ON "WorkspaceAuditEvent"("workspaceId", "createdAt");
CREATE INDEX "Conversation_workspaceId_idx" ON "Conversation"("workspaceId");

ALTER TABLE "Workspace" ADD CONSTRAINT "Workspace_personalOwnerId_fkey" FOREIGN KEY ("personalOwnerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WorkspaceMember" ADD CONSTRAINT "WorkspaceMember_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WorkspaceMember" ADD CONSTRAINT "WorkspaceMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WorkspaceConnection" ADD CONSTRAINT "WorkspaceConnection_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WorkspaceAuditEvent" ADD CONSTRAINT "WorkspaceAuditEvent_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
