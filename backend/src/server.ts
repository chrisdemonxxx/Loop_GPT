import dotenv from 'dotenv'
dotenv.config()

// Validate before loading routes, initializing providers, or registering error
// handlers. A bad production environment must terminate startup.
import { validateEnv } from './middleware/envValidation'
validateEnv()

// Initialize Sentry as early as possible (no-op without SENTRY_DSN).
import * as Sentry from '@sentry/node'
if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || 'production',
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE) || 0.1,
  })
}

// Unexpected process failures are fatal; the process manager can restart a
// clean instance rather than leave a partially corrupted worker serving traffic.
process.on('unhandledRejection', (reason: any) => {
  console.error('Unhandled rejection:', reason?.message || reason)
  if (process.env.SENTRY_DSN) Sentry.captureException(reason)
  process.exit(1)
})
process.on('uncaughtException', (err: any) => {
  console.error('Uncaught exception:', err?.message || err)
  if (process.env.SENTRY_DSN) Sentry.captureException(err)
  process.exit(1)
})

import express from 'express'
import cors from 'cors'
import conversationRoutes from './routes/conversations'
import messageRoutes from './routes/messages'
import authRoutes from './routes/auth'
import settingsRoutes from './routes/settings'
import modelsRoutes from './routes/models'
import agentRoutes from './routes/agent'
import telemetryRoutes from './routes/telemetry'
import accountRoutes from './routes/account'
import adminRoutes from './routes/admin'
import { oauthRouter, mailRouter, oauthRelayRouter } from './routes/oauth'
import billingRoutes, { stripeWebhook } from './routes/billing'
import mediaRoutes from './routes/media'
import developerRoutes from './routes/developer'
import v1Routes from './routes/v1'
import { rateLimiter } from './middleware/rateLimiter'
import { createCorsOriginPolicy } from './middleware/corsPolicy'
import { asyncHandler, errorLogger } from './middleware/errorLogger'
import { requestLog, recentRequests, metricsSummary, activeStreamCount } from './middleware/requestLog'
import { initAgent } from './agent'
import { filesRouter, imageUploadRouter, rejectLegacyUploads } from './routes/files'
import workspaceRoutes from './routes/workspaces'
import { oauthConnectorRouter } from './routes/oauthConnector'


// Register reviewed built-ins; legacy shared extensions are not bootstrapped.
initAgent().catch((err) => console.error('Agent init error:', err))
// Legacy media jobs must not auto-submit on restart without reservation linkage
// and a distributed dispatch claim. Keep persisted jobs for manual reconciliation.

const app = express()
const PORT = process.env.PORT || 3001

// Exact configured origins only. Hosting-provider siblings are not trusted.
const isAllowedOrigin = createCorsOriginPolicy(process.env.FRONTEND_URL || 'http://localhost:3000')
app.use(
  cors({
    origin(origin, cb) {
      return cb(null, isAllowedOrigin(origin))
    },
    credentials: true,
  })
)
// Per-request structured observability. One JSON line per completed request
// (SSE 'finish' fires at stream close, so agent-turn durations are visible).
// Never logs headers, bodies, query strings, tokens, or exception details.
app.use(requestLog())
// Stripe webhook needs the raw body for signature verification — mount BEFORE json().
app.post('/api/billing/webhook', express.raw({ type: 'application/json' }), asyncHandler(stripeWebhook))

// Credential-bearing workspace requests have their own small parser and error
// boundary; do not send parse errors/bodies through general request logging.
app.use('/api/workspaces', rateLimiter(15 * 60 * 1000, 100), workspaceRoutes)

// 75MB so /v1/media/publish can carry base64 video payloads (≈50MB decoded cap on the route).
app.use(express.json({ limit: '75mb' }))

// Rate limiting (100 requests per 15 minutes per user/IP)
app.use('/api', rateLimiter(15 * 60 * 1000, 100))

app.use('/uploads', rejectLegacyUploads)
app.use('/api/files', filesRouter)
app.use('/api/conversations', imageUploadRouter)

// Routes
app.use('/api/auth', authRoutes)
app.use('/api/auth', oauthRouter)
app.use('/api/oauth-connector', oauthConnectorRouter)
app.use('/api/oauth-connector', oauthConnectorRouter)
// Root-level /oauth/:provider relay (social-login buttons built from DOMAIN_SERVER land here)
app.use(oauthRelayRouter)
app.use('/api/mail', mailRouter)
app.use('/api/settings', settingsRoutes)
app.use('/api/models', modelsRoutes)
app.use('/api/conversations', conversationRoutes)
app.use('/api/conversations', messageRoutes)
app.use('/api/conversations', agentRoutes)
app.use('/api/agent', agentRoutes)
app.use('/api/telemetry', telemetryRoutes)
app.use('/api/account', accountRoutes)
app.use('/api/admin', adminRoutes)
app.use('/api/billing', billingRoutes)
app.use('/api/media', mediaRoutes)
app.use('/api/developer', developerRoutes)
// Public developer API. Deliberately NOT behind the global /api IP rate limiter —
// it enforces its own per-key, per-plan limits in middleware/apiAuth.
app.use('/v1', v1Routes)

// Root route
app.get('/', (req, res) => {
  res.json({
    name: 'Loop GPT API',
    version: '1.0.0',
    status: 'running',
    timestamp: new Date().toISOString(),
    endpoints: {
      health: '/health',
      auth: {
        register: 'POST /api/auth/register',
        login: 'POST /api/auth/login',
      },
      conversations: {
        list: 'GET /api/conversations',
        get: 'GET /api/conversations/:id',
        create: 'POST /api/conversations',
        update: 'PATCH /api/conversations/:id',
        delete: 'DELETE /api/conversations/:id',
      },
      messages: {
        get: 'GET /api/conversations/:id/messages',
        send: 'POST /api/conversations/:id/messages',
        uploadImage: 'POST /api/conversations/:id/upload-image',
      },
    },
    features: [
      'Chat with AI (GPT models)',
      'Image generation (FLUX/SD models)',
      'Vision analysis (BLIP/LLaVA)',
      'Vision Q&A',
      'Conversation management',
    ],
  })
})

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() })
})

// Report errors to Sentry (no-op without SENTRY_DSN), then log.
if (process.env.SENTRY_DSN) {
  Sentry.setupExpressErrorHandler(app)
}

// Error handling middleware (must be last)
app.use(errorLogger)

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`)
  console.log(`📝 Environment: ${process.env.NODE_ENV || 'development'}`)
  console.log(`🌐 CORS enabled for: ${process.env.FRONTEND_URL || 'http://localhost:3000'}`)
})

