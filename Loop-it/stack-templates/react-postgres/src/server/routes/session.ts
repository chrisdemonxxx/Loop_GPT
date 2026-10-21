import { Router } from 'express';

// A minimal auth endpoint: it returns the identity carried by the verified JWT.
// It exists to demonstrate two things — where an auth-sensitive route lives, and
// that such routes sit behind the auth rate limiter (see app.ts). Token issuance
// itself is handled by the managed auth service (GoTrue), not by generated apps.

export function sessionRouter(): Router {
  const router = Router();
  router.get('/', (req, res) => {
    res.json({ identity: req.identity });
  });
  return router;
}
