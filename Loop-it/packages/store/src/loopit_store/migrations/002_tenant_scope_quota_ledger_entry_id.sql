DO $$
DECLARE
    current_pk_columns text[];
BEGIN
    SELECT array_agg(a.attname ORDER BY cols.ord)
    INTO current_pk_columns
    FROM pg_constraint c
    JOIN unnest(c.conkey) WITH ORDINALITY AS cols(attnum, ord) ON true
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = cols.attnum
    WHERE c.conrelid = 'quota_ledger'::regclass
      AND c.contype = 'p'
    GROUP BY c.oid;

    IF current_pk_columns IS DISTINCT FROM ARRAY['tenant_id', 'entry_id'] THEN
        IF current_pk_columns IS NOT NULL THEN
            ALTER TABLE quota_ledger DROP CONSTRAINT quota_ledger_pkey;
        END IF;
        ALTER TABLE quota_ledger ADD PRIMARY KEY (tenant_id, entry_id);
    END IF;
END;
$$;
