import dotenv from 'dotenv'
dotenv.config()

// Initialize Sentry as early as possible (no-op without SENTRY_DSN).
import * as Sentry from '@sentry/node'
if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || 'production',
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE) || 0.1,
  })
}

// Keep the server alive on stray async errors (report to Sentry, don't exit).
process.on('unhandledRejection', (reason: any) => {
  console.error('Unhandled rejection:', reason?.message || reason)
  if (process.env.SENTRY_DSN) Sentry.captureException(reason)
})
process.on('uncaughtException', (err: any) => {
  console.error('Uncaught exception:', err?.message || err)
  if (process.env.SENTRY_DSN) Sentry.captureException(err)
})

import express from 'express'
import cors from 'cors'
import path from 'path'
import conversationRoutes from './routes/conversations'
import messageRoutes from './routes/messages'
import authRoutes from './routes/auth'
import settingsRoutes from './routes/settings'
import modelsRoutes from './routes/models'
import agentRoutes from './routes/agent'
import telemetryRoutes from './routes/telemetry'
import accountRoutes from './routes/account'
import adminRoutes from './routes/admin'
import { oauthRouter, mailRouter } from './routes/oauth'
import billingRoutes, { stripeWebhook } from './routes/billing'
import { validateEnv } from './middleware/envValidation'
import { rateLimiter } from './middleware/rateLimiter'
import { errorLogger } from './middleware/errorLogger'
import { initAgent } from './agent'

// Validate environment variables on startup
validateEnv()

// Initialize the agent runtime (register tools, connect MCP servers, etc.)
initAgent().catch((err) => console.error('Agent init error:', err))

const app = express()
const PORT = process.env.PORT || 3001

// Middleware — CORS allows a comma-separated FRONTEND_URL allowlist, any
// *.up.railway.app origin (Railway service URLs), and requests without an Origin
// (curl/server-to-server). This keeps the app working on both the custom domain
// and the Railway-generated URL without a redeploy per domain change.
const allowedOrigins = (process.env.FRONTEND_URL || 'http://localhost:3000')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
app.use(
  cors({
    origin(origin, cb) {
      if (!origin) return cb(null, true)
      if (allowedOrigins.includes(origin)) return cb(null, true)
      try {
        if (/(^|\.)up\.railway\.app$/.test(new URL(origin).hostname)) return cb(null, true)
      } catch {
        /* malformed origin */
      }
      return cb(null, false)
    },
    credentials: true,
  })
)
// Stripe webhook needs the raw body for signature verification — mount BEFORE json().
app.post('/api/billing/webhook', express.raw({ type: 'application/json' }), stripeWebhook)

app.use(express.json())

// Rate limiting (100 requests per 15 minutes per user/IP)
app.use('/api', rateLimiter(15 * 60 * 1000, 100))

// Serve uploaded images
app.use('/uploads', express.static(path.join(__dirname, '../uploads')))

// Routes
app.use('/api/auth', authRoutes)
app.use('/api/auth', oauthRouter)
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

