DO $$
DECLARE
    audit_role_password text := current_setting('loopit.audit_role_password', true);
BEGIN
    IF audit_role_password IS NULL OR audit_role_password = '' THEN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'loopit_audit_writer') THEN
            CREATE ROLE loopit_audit_writer NOLOGIN;
        END IF;
    ELSIF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'loopit_audit_writer') THEN
        EXECUTE format('CREATE ROLE loopit_audit_writer LOGIN PASSWORD %L', audit_role_password);
    ELSE
        EXECUTE format('ALTER ROLE loopit_audit_writer LOGIN PASSWORD %L', audit_role_password);
    END IF;
END;
$$;

GRANT USAGE ON SCHEMA loopit TO loopit_audit_writer;
GRANT INSERT ON audit_log TO loopit_audit_writer;
GRANT USAGE ON SEQUENCE audit_log_audit_id_seq TO loopit_audit_writer;
REVOKE SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON audit_log FROM loopit_audit_writer;
REVOKE SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON audit_log_default FROM loopit_audit_writer;

CREATE OR REPLACE FUNCTION loopit_latest_audit_row_hash()
RETURNS text
LANGUAGE sql
SECURITY DEFINER
SET search_path = loopit
AS $function$
    SELECT row_hash FROM audit_log ORDER BY audit_id DESC LIMIT 1;
$function$;

REVOKE ALL ON FUNCTION loopit_latest_audit_row_hash() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION loopit_latest_audit_row_hash() TO loopit_audit_writer;
