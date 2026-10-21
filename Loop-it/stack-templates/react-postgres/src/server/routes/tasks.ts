import { Router } from 'express';
import type { Pool } from 'pg';
import { withIdentity } from '../db.js';
import { HttpError } from '../errors.js';

// The example feature: a per-user `tasks` CRUD. It demonstrates the one correct
// end-to-end pattern for this stack:
//
//   1. requireAuth has already verified the JWT and attached req.identity.
//   2. withIdentity opens a transaction and pins that identity into
//      request.jwt.claims BEFORE any query runs.
//   3. Every statement is parameterised.
//   4. Row-level security — not an application WHERE clause — is what scopes rows
//      to the caller. auth.uid() inside the transaction resolves to this user, so
//      the policies emitted by loopit_provision filter reads and constrain writes.
//      The app never has to remember `WHERE user_id = ?`; if it forgets to
//      propagate identity, RLS returns zero rows rather than another user's data.

interface TaskRow {
  id: string;
  title: string;
  done: boolean;
  created_at: string;
  updated_at: string;
}

function parseTitle(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new HttpError(400, 'title is required');
  }
  if (value.length > 500) {
    throw new HttpError(400, 'title is too long');
  }
  return value;
}

function parseDone(value: unknown): boolean {
  if (typeof value !== 'boolean') {
    throw new HttpError(400, 'done must be a boolean');
  }
  return value;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Ids reach a uuid column, and Postgres raises on a malformed one — which the
// error handler would surface as an opaque 500. A client typo is not a server
// fault, so it is rejected here. 404 rather than 400 deliberately: a caller must
// not be able to tell "malformed id" from "exists but is not yours", which is
// the same answer row-level security would have given.
function parseId(value: string): string {
  if (!UUID.test(value)) {
    throw new HttpError(404, 'task not found');
  }
  return value;
}

export function tasksRouter(pool: Pool): Router {
  const router = Router();

  router.get('/', (req, res, next) => {
    void (async () => {
      try {
        const identity = req.identity;
        if (identity === undefined) {
          throw new HttpError(401, 'unauthorized');
        }
        const rows = await withIdentity(pool, identity, async (sql) => {
          const result = await sql<TaskRow>(
            'SELECT id, title, done, created_at, updated_at FROM tasks ORDER BY created_at DESC',
          );
          return result.rows;
        });
        res.json({ tasks: rows });
      } catch (error) {
        next(error);
      }
    })();
  });

  router.post('/', (req, res, next) => {
    void (async () => {
      try {
        const identity = req.identity;
        if (identity === undefined) {
          throw new HttpError(401, 'unauthorized');
        }
        const title = parseTitle(req.body?.title);
        const done = req.body?.done === undefined ? false : parseDone(req.body.done);
        const row = await withIdentity(pool, identity, async (sql) => {
          // user_id is omitted on purpose: it defaults to auth.uid() in the
          // schema, so ownership is set by the database from the verified
          // identity, never from client-supplied input.
          const result = await sql<TaskRow>(
            'INSERT INTO tasks (title, done) VALUES ($1, $2) RETURNING id, title, done, created_at, updated_at',
            [title, done],
          );
          return result.rows[0];
        });
        res.status(201).json({ task: row });
      } catch (error) {
        next(error);
      }
    })();
  });

  router.patch('/:id', (req, res, next) => {
    void (async () => {
      try {
        const identity = req.identity;
        if (identity === undefined) {
          throw new HttpError(401, 'unauthorized');
        }
        const title = req.body?.title === undefined ? null : parseTitle(req.body.title);
        const done = req.body?.done === undefined ? null : parseDone(req.body.done);
        const row = await withIdentity(pool, identity, async (sql) => {
          const result = await sql<TaskRow>(
            'UPDATE tasks SET title = COALESCE($1, title), done = COALESCE($2, done) ' +
              'WHERE id = $3 RETURNING id, title, done, created_at, updated_at',
            [title, done, parseId(req.params.id)],
          );
          return result.rows[0];
        });
        if (row === undefined) {
          throw new HttpError(404, 'task not found');
        }
        res.json({ task: row });
      } catch (error) {
        next(error);
      }
    })();
  });

  router.delete('/:id', (req, res, next) => {
    void (async () => {
      try {
        const identity = req.identity;
        if (identity === undefined) {
          throw new HttpError(401, 'unauthorized');
        }
        const deleted = await withIdentity(pool, identity, async (sql) => {
          const result = await sql('DELETE FROM tasks WHERE id = $1', [parseId(req.params.id)]);
          return result.rowCount ?? 0;
        });
        if (deleted === 0) {
          throw new HttpError(404, 'task not found');
        }
        res.status(204).end();
      } catch (error) {
        next(error);
      }
    })();
  });

  return router;
}
