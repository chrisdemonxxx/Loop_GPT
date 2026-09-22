-- Password-reset session invalidation: authenticateToken rejects JWTs
-- issued before this instant, so resetting a password kills old sessions.
ALTER TABLE "User" ADD COLUMN "sessionInvalidatedAt" TIMESTAMP(3);

