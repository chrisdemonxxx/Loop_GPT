CREATE TABLE "PrivateFile" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "conversationId" TEXT,
    "name" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),
    CONSTRAINT "PrivateFile_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "PrivateFile_userId_createdAt_idx" ON "PrivateFile"("userId", "createdAt");
CREATE INDEX "PrivateFile_conversationId_idx" ON "PrivateFile"("conversationId");
ALTER TABLE "PrivateFile" ADD CONSTRAINT "PrivateFile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PrivateFile" ADD CONSTRAINT "PrivateFile_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
