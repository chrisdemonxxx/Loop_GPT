-- Paired browser devices and authorization grants for browser agent
CREATE TABLE "BrowserDevice" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "family" TEXT NOT NULL,
    "browserName" TEXT NOT NULL,
    "profileLabel" TEXT NOT NULL DEFAULT '',
    "packageVersion" TEXT NOT NULL DEFAULT '',
    "packageKind" TEXT NOT NULL DEFAULT '',
    "installId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "pairedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "needsYou" JSONB,

    CONSTRAINT "BrowserDevice_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "BrowserGrant" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "runId" TEXT,
    "used" BOOLEAN NOT NULL DEFAULT false,
    "revoked" BOOLEAN NOT NULL DEFAULT false,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BrowserGrant_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BrowserDevice_tokenHash_key" ON "BrowserDevice"("tokenHash");
CREATE UNIQUE INDEX "BrowserDevice_userId_installId_key" ON "BrowserDevice"("userId", "installId");
CREATE INDEX "BrowserDevice_userId_idx" ON "BrowserDevice"("userId");

CREATE INDEX "BrowserGrant_userId_deviceId_idx" ON "BrowserGrant"("userId", "deviceId");
CREATE INDEX "BrowserGrant_runId_idx" ON "BrowserGrant"("runId");
CREATE INDEX "BrowserGrant_expiresAt_idx" ON "BrowserGrant"("expiresAt");

ALTER TABLE "BrowserDevice" ADD CONSTRAINT "BrowserDevice_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BrowserGrant" ADD CONSTRAINT "BrowserGrant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BrowserGrant" ADD CONSTRAINT "BrowserGrant_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "BrowserDevice"("id") ON DELETE CASCADE ON UPDATE CASCADE;
