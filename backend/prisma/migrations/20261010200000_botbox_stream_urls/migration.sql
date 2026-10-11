-- Additive: persist the persistent box's noVNC stream credentials.
--
-- The @e2b/desktop SDK keeps the stream auth key and the vnc.html URL builder
-- in instance-local state. After a backend restart the box is reconnected via
-- Sandbox.connect, and the new SDK instance can neither read the auth key nor
-- rebuild the stream URLs — the old code returned an empty streamUrl and the
-- Computer tab showed "stream unavailable" until the box died (up to 1h) and
-- cold-booted. With the credentials on the row, any process can rebuild the
-- URLs for the sandbox's lifetime.

ALTER TABLE "BotBox" ADD COLUMN "streamAuthKey" TEXT;
ALTER TABLE "BotBox" ADD COLUMN "streamUrl" TEXT;
ALTER TABLE "BotBox" ADD COLUMN "interactiveUrl" TEXT;
ALTER TABLE "BotBox" ADD COLUMN "streamStartedAt" TIMESTAMP(3);
