/**
 * Lightweight telemetry: user feedback (👍/👎 on answers) and client error
 * reports. Appended to JSONL under data/ (works without a database) — these
 * feed the future training-data flywheel and the auto-heal pipeline.
 */
import express from 'express'
import fs from 'fs'
import path from 'path'
import { authenticateToken } from './auth'

const router = express.Router()
const DATA_DIR = path.join(__dirname, '../../data')

function append(name: string, record: any) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true })
    fs.appendFileSync(path.join(DATA_DIR, name), JSON.stringify(record) + '\n')
  } catch {
    /* best-effort */
  }
}

// Feedback on an assistant message (thumbs up/down + optional comment).
router.post('/feedback', authenticateToken, (req, res) => {
  const userId = (req as any).userId
  const { conversationId, messageId, rating, comment } = req.body || {}
  if (rating !== 'up' && rating !== 'down') return res.status(400).json({ error: 'rating must be "up" or "down"' })
  append('feedback.jsonl', {
    ts: new Date().toISOString(),
    userId,
    conversationId: conversationId || null,
    messageId: messageId || null,
    rating,
    comment: typeof comment === 'string' ? comment.slice(0, 1000) : null,
  })
  res.json({ ok: true })
})

// Client-side error report (open, but size-capped and rate-limited upstream).
router.post('/error', (req, res) => {
  const { message, stack, url, userAgent } = req.body || {}
  if (!message) return res.status(400).json({ error: 'message is required' })
  append('errors.jsonl', {
    ts: new Date().toISOString(),
    message: String(message).slice(0, 500),
    stack: typeof stack === 'string' ? stack.slice(0, 2000) : null,
    url: typeof url === 'string' ? url.slice(0, 300) : null,
    userAgent: typeof userAgent === 'string' ? userAgent.slice(0, 300) : null,
  })
  res.json({ ok: true })
})

export default router
