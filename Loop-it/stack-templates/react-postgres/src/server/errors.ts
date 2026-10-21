import type { NextFunction, Request, Response } from 'express';

// Client-facing errors never carry internals. A caller gets a stable status code
// and an opaque message; the stack trace, driver error, and failing SQL are
// logged server-side only. Leaking a Postgres error text (constraint names,
// column names, "relation does not exist") hands an attacker a map of the schema.

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function notFound(_req: Request, res: Response): void {
  res.status(404).json({ error: 'not found' });
}

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  console.error('unhandled error:', err);
  res.status(500).json({ error: 'internal server error' });
}
