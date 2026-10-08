#!/usr/bin/env node
/**
 * Load probe for the chat-streaming and billing paths.
 *
 * No credentials live in this file. Pass a staging token at runtime:
 *   LOOP_LOADTEST_BASE_URL   default http://127.0.0.1:3001
 *   LOOP_LOADTEST_TOKEN      optional bearer; omit to measure unauthenticated 401s
 *   LOOP_LOADTEST_CONVERSATION_ID   default "loadtest"
 *
 * Usage:
 *   node backend/scripts/loadtest.mjs --concurrency 8 --requests 16
 *   node backend/scripts/loadtest.mjs --concurrency 20 --requests 40 --allow-remote
 *
 * --allow-remote is required when the base URL is not loopback. Point it at
 * staging, not production. A stream request can spend credits until the
 * server notices the client abort. Checkout may create a Stripe session and
 * does not capture a payment by itself.
 */

const args = process.argv.slice(2)

function flag(name, fallback) {
  const index = args.indexOf(name)
  if (index === -1 || !args[index + 1]) return fallback
  return args[index + 1]
}

function has(name) {
  return args.includes(name)
}

function usage() {
  console.log(`Usage: node backend/scripts/loadtest.mjs [--concurrency N] [--requests N] [--stream-ms N] [--allow-remote]
Reads LOOP_LOADTEST_BASE_URL, LOOP_LOADTEST_TOKEN, LOOP_LOADTEST_CONVERSATION_ID from the environment.`)
}

if (has('--help')) {
  usage()
  process.exit(0)
}

const concurrency = Number(flag('--concurrency', '4'))
const requests = Number(flag('--requests', '8'))
const streamMs = Number(flag('--stream-ms', '3000'))
const base = String(process.env.LOOP_LOADTEST_BASE_URL || 'http://127.0.0.1:3001').replace(/\/+$/, '')
const token = process.env.LOOP_LOADTEST_TOKEN || ''
const conversationId = process.env.LOOP_LOADTEST_CONVERSATION_ID || 'loadtest'

if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 200) {
  console.error('concurrency must be an integer from 1 to 200')
  process.exit(2)
}
if (!Number.isInteger(requests) || requests < 1 || requests > 5000) {
  console.error('requests must be an integer from 1 to 5000')
  process.exit(2)
}
if (!Number.isInteger(streamMs) || streamMs < 100 || streamMs > 60000) {
  console.error('stream-ms must be an integer from 100 to 60000')
  process.exit(2)
}

let host = ''
try { host = new URL(base).hostname } catch {
  console.error('LOOP_LOADTEST_BASE_URL is not a URL')
  process.exit(2)
}
const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1'
if (!loopback && !has('--allow-remote')) {
  console.error('Refusing a non-loopback URL without --allow-remote. Use the staging origin.')
  process.exit(2)
}

function headers(json) {
  const out = {}
  if (json) out['Content-Type'] = 'application/json'
  if (token) out.Authorization = `Bearer ${token}`
  return out
}

async function one(path, init, timeoutMs) {
  const started = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let status = 0
  let error = ''
  try {
    const res = await fetch(`${base}${path}`, { ...init, signal: controller.signal })
    status = res.status
    await res.arrayBuffer().catch(() => undefined)
  } catch (err) {
    error = err && err.name === 'AbortError' ? 'aborted' : 'network'
  } finally {
    clearTimeout(timer)
  }
  return { status, ms: Date.now() - started, error }
}

async function pool(jobs) {
  const results = []
  let next = 0
  async function worker() {
    for (;;) {
      const index = next
      next += 1
      if (index >= jobs.length) return
      results[index] = await jobs[index]()
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, () => worker()))
  return results
}

function summarize(name, rows) {
  const times = rows.map((row) => row.ms).sort((a, b) => a - b)
  const pick = (p) => times[Math.min(times.length - 1, Math.max(0, Math.ceil((p / 100) * times.length) - 1))] || 0
  const statuses = {}
  let errors = 0
  for (const row of rows) {
    const key = row.error || String(row.status)
    statuses[key] = (statuses[key] || 0) + 1
    if (row.error === 'network' || row.status === 500) errors += 1
  }
  return { path: name, requests: rows.length, errors, p50Ms: pick(50), p95Ms: pick(95), statuses }
}

const streamJobs = Array.from({ length: requests }, () => () => one(
  `/api/agent/${encodeURIComponent(conversationId)}/stream`,
  { method: 'POST', headers: headers(true), body: JSON.stringify({ content: 'Reply with the single word ok.' }) },
  streamMs,
))
const billingJobs = Array.from({ length: requests }, (_, index) => () => {
  if (index % 2 === 0) {
    return one('/api/billing/config', { method: 'GET', headers: headers(false) }, 10000)
  }
  return one('/api/billing/checkout', {
    method: 'POST',
    headers: headers(true),
    body: JSON.stringify({ plan: 'pro' }),
  }, 10000)
})

const [streamRows, billingRows] = await Promise.all([pool(streamJobs), pool(billingJobs)])
const report = {
  base,
  concurrency,
  authenticated: Boolean(token),
  chatStream: summarize('POST /api/agent/:id/stream', streamRows),
  billing: summarize('GET /api/billing/config + POST /api/billing/checkout', billingRows),
}
console.log(JSON.stringify(report, null, 2))
const failed = report.chatStream.errors + report.billing.errors
process.exit(failed > 0 ? 1 : 0)
