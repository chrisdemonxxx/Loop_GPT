-- Fix drift: the projects migration created Project.role as TEXT but the schema
-- uses the ProjectRole enum. Create the enum and convert the column. Drop the
-- text default first so the cast is clean.
DO $$ BEGIN
  CREATE TYPE "ProjectRole" AS ENUM ('owner', 'editor', 'viewer');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE "Project" ALTER COLUMN "role" DROP DEFAULT;
ALTER TABLE "Project" ALTER COLUMN "role" TYPE "ProjectRole" USING "role"::"ProjectRole";
ALTER TABLE "Project" ALTER COLUMN "role" SET DEFAULT 'viewer'::"ProjectRole";
