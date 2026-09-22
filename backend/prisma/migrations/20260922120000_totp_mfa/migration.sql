-- TOTP MFA (brief P2): optional per-user two-factor login (RFC 6238).
ALTER TABLE "User" ADD COLUMN "totpEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "User" ADD COLUMN "totpSecret" TEXT;

