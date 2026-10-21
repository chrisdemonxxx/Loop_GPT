import express from 'express';
import type { Express } from 'express';
import type { Pool } from 'pg';
import type { ServerConfig } from './config.js';
import { requireAuth } from './auth.js';
import { authRateLimiter, corsPolicy, securityHeaders } from './security.js';
import { errorHandler, notFound } from './errors.js';
import { tasksRouter } from './routes/tasks.js';
import { sessionRouter } from './routes/session.js';

export function createApp(config: ServerConfig, pool: Pool): Express {
  const app = express();

  // Trust the reverse proxy in front of the app so rate limiting and protocol
  // detection see the real client address (previews are served through the
  // control-plane proxy — see docs/06 §6).
  app.set('trust proxy', 1);

  app.use(securityHeaders());
  app.use(corsPolicy(config.corsAllowedOrigins));
  app.use(express.json({ limit: '100kb' }));

  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok' });
  });

  const auth = requireAuth({ secret: config.jwtSecret, algorithms: config.jwtAlgorithms });

  // Auth-sensitive routes are rate limited and require a verified token.
  app.use('/api/auth/session', authRateLimiter(), auth, sessionRouter());
  app.use('/api/tasks', auth, tasksRouter(pool));

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
