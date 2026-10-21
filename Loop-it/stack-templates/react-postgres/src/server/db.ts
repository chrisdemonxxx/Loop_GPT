import { Pool } from 'pg';
import type { PoolClient, QueryResult, QueryResultRow } from 'pg';

// There is exactly one way to run SQL in this codebase, and it takes the query
// text and its bound values as two separate arguments. There is no exported
// helper anywhere that accepts a single interpolated string, because a template
// that makes string concatenation convenient will get string concatenation —
// and concatenated SQL is SQL injection (threat class 3, docs/08). Every value
// a query depends on must arrive as a $n parameter.

export interface RequestIdentity {
  readonly userId: string;
  readonly orgId?: string | null;
}

export type Sql = <T extends QueryResultRow = QueryResultRow>(
  text: string,
  values?: readonly unknown[],
) => Promise<QueryResult<T>>;

// Guards the one invariant the query helper exists to protect: values are bound
// as parameters, never spliced into the SQL text. It rejects the two shapes that
// signal a developer has drifted back to concatenation — a placeholder/value
// count mismatch, and values supplied against text that has no placeholders.
export function assertParameterised(text: string, values: readonly unknown[]): void {
  if (typeof text !== 'string' || text.trim() === '') {
    throw new Error('query text must be a non-empty string');
  }
  if (!Array.isArray(values)) {
    throw new Error('query values must be an array; pass parameters, never interpolated SQL');
  }

  const referenced = new Set<number>();
  const placeholder = /\$(\d+)/g;
  let match: RegExpExecArray | null;
  while ((match = placeholder.exec(text)) !== null) {
    referenced.add(Number(match[1]));
  }
  const highest = referenced.size > 0 ? Math.max(...referenced) : 0;

  if (values.length > 0 && referenced.size === 0) {
    throw new Error(
      'values were supplied but the SQL has no $n placeholders; it appears to be concatenated',
    );
  }
  if (highest !== values.length) {
    throw new Error(
      `parameter count mismatch: SQL references up to $${highest} but ${values.length} value(s) supplied`,
    );
  }
}

interface Queryable {
  query<T extends QueryResultRow>(text: string, values: unknown[]): Promise<QueryResult<T>>;
}

function makeQuery(runner: Queryable): Sql {
  return <T extends QueryResultRow = QueryResultRow>(
    text: string,
    values: readonly unknown[] = [],
  ) => {
    assertParameterised(text, values);
    return runner.query<T>(text, [...values]);
  };
}

export function createPool(databaseUrl: string): Pool {
  return new Pool({ connectionString: databaseUrl });
}

// Runs `work` inside a single transaction whose very first statement pins the
// verified caller's identity into request.jwt.claims. Row-level security reads
// that setting (auth.uid() and the org_id claim), so it MUST be set in the same
// transaction as the query or every policy evaluates against a null identity and
// returns zero rows. set_config(..., true) makes it LOCAL: it is scoped to this
// transaction and cleared on COMMIT/ROLLBACK, so a pooled connection can never
// carry one request's identity into the next.
export async function withIdentity<T>(
  pool: Pool,
  identity: RequestIdentity,
  work: (sql: Sql) => Promise<T>,
): Promise<T> {
  const client: PoolClient = await pool.connect();
  try {
    await client.query('BEGIN');
    const claims = JSON.stringify({ sub: identity.userId, org_id: identity.orgId ?? null });
    await client.query("SELECT set_config('request.jwt.claims', $1, true)", [claims]);
    const result = await work(makeQuery(client));
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
