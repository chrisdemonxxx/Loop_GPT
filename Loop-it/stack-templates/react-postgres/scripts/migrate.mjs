import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

// Applies every .sql file in ./migrations in filename order, each in its own
// transaction-per-file (the generated migrations already wrap themselves in
// BEGIN/COMMIT). Connect with a role that is app_user, not the table owner, so
// row-level security is exercised the same way in dev as in prod.
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'migrations');

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error('DATABASE_URL is required');
}

const client = new pg.Client({ connectionString: databaseUrl });
await client.connect();
try {
  const files = (await readdir(migrationsDir)).filter((name) => name.endsWith('.sql')).sort();
  for (const file of files) {
    const sql = await readFile(join(migrationsDir, file), 'utf8');
    console.warn(`applying ${file}`);
    await client.query(sql);
  }
  console.warn('migrations complete');
} finally {
  await client.end();
}
