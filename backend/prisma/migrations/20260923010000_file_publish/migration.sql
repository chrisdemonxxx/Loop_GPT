-- View-only public links for private files (GAP-020).
ALTER TABLE "PrivateFile" ADD COLUMN "publishToken" TEXT;
ALTER TABLE "PrivateFile" ADD COLUMN "publishedAt" TIMESTAMP(3);
CREATE UNIQUE INDEX "PrivateFile_publishToken_key" ON "PrivateFile"("publishToken");
