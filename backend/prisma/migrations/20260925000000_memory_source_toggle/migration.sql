-- Memory UX (Settings -> Memory): distinguish user-added vs agent-learned rows and
-- add the global "use memory across conversations" toggle.
ALTER TABLE "Memory" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'user';
ALTER TABLE "User" ADD COLUMN "memoryEnabled" BOOLEAN NOT NULL DEFAULT true;

