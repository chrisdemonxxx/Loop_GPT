-- Persistent-box operator control. View-only stays the default; the noVNC
-- proxy allows keyboard and pointer input when this flag is set for the sandbox.
ALTER TABLE "BotBox" ADD COLUMN "takeoverRequested" BOOLEAN NOT NULL DEFAULT false;
