-- Bootstrap migration: the role and identity plumbing every generated schema
-- assumes. This must run before any table migration produced by
-- loopit_provision, because those migrations GRANT to app_user and their RLS
-- policies call auth.uid().
--
-- Do not hand-edit table migrations to "fix" a missing role — fix it here.
BEGIN;

-- The role generated applications connect as. It is deliberately distinct from
-- the migration/owner role: FORCE ROW LEVEL SECURITY only protects against a
-- non-owner, so the app must never connect as the role that owns the tables.
-- NOLOGIN because a login role (e.g. app_login) should be GRANTed this role
-- rather than app_user carrying a password itself.
DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'app_user') THEN
        CREATE ROLE app_user NOLOGIN;
    END IF;
END
$$;

-- The auth schema and auth.uid() follow the GoTrue/PostgREST convention: the
-- current end-user id is read from the verified JWT claims that the request
-- injected into the transaction (request.jwt.claims -> 'sub'), never from
-- anything the application passes in a WHERE clause. The RLS policies emitted by
-- loopit_provision compare the ownership column against exactly this expression.
CREATE SCHEMA IF NOT EXISTS auth;

CREATE OR REPLACE FUNCTION auth.uid()
    RETURNS uuid
    LANGUAGE sql
    STABLE
    SET search_path = pg_catalog
AS $$
    SELECT nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'sub', '')::uuid;
$$;

GRANT USAGE ON SCHEMA auth TO app_user;
GRANT EXECUTE ON FUNCTION auth.uid() TO app_user;
GRANT USAGE ON SCHEMA public TO app_user;

COMMIT;
