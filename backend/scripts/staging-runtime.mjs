#!/usr/bin/env node
// Isolated staging only. No migrations or namespace initialization at startup.
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { createServer, Server } from 'node:http'

const root = fileURLToPath(new URL('../', import.meta.url))
const require = createRequire(import.meta.url)
const children = new Map()
let stopping = false, failed = false, killTimer, server, interval, prisma
let ready = false, checkedAt = 0
const env = { ...process.env }
const integer = (key, fallback, min, max) => {
  const text = env[key] ?? String(fallback)
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(+text) || +text < min || +text > max) throw new Error(`Invalid ${key}`)
  return +text
}
const flag = (key) => {
  env[key] ??= 'false'
  if (!['true', 'false'].includes(env[key])) throw new Error(`Invalid ${key}`)
  return env[key] === 'true'
}

function shutdown(error = false) {
  failed ||= error
  if (stopping) return
  stopping = true
  ready = false
  clearInterval(interval)
  server?.close()
  for (const child of children.values()) child.kill('SIGTERM')
  killTimer = setTimeout(() => {
    failed = true
    for (const child of children.values()) child.kill('SIGKILL')
    // A wedged DB/check must not keep PID 1 alive indefinitely.
    setTimeout(() => process.exit(1), 1000).unref()
  }, graceMs)
  killTimer.unref()
  finish()
}

function finish() {
  if (!stopping || children.size) return
  clearTimeout(killTimer)
  const lastResort = setTimeout(() => process.exit(1), 1000)
  lastResort.unref()
  Promise.resolve(prisma?.$disconnect()).catch(() => { failed = true }).finally(() => process.exit(failed ? 1 : 0))
}

function childProcess(name, script, args = [], childEnv = env) {
  const child = spawn(process.execPath, [resolve(root, script), ...args], {
    cwd: root, env: childEnv, stdio: 'inherit', shell: false,
  })
  children.set(name, child)
  return new Promise((done, reject) => {
    child.once('error', () => { failed = true; reject(new Error(`${name} could not start`)) })
    child.once('close', (code, signal) => {
      children.delete(name)
      if (stopping) { finish(); done(); return }
      if (name === 'preflight') {
        if (code === 0) done()
        else reject(new Error('Migration status check failed; run the explicit release step'))
      } else {
        console.error(`[staging] essential child ${name} exited (code=${code}, signal=${signal})`)
        // Even exit 0 is unexpected for a continuous essential child.
        shutdown(true)
        done()
      }
    })
  })
}

// A deadline changes readiness, not ownership of the underlying I/O. A stalled
// filesystem/Prisma operation cannot be cancelled by racing its promise.
export function createReadinessCheck({ probe, report, isStopping, timeoutMs = 5000 }) {
  let checking = false
  return async () => {
    if (checking || isStopping()) return
    checking = true
    let expired = false
    const timeout = setTimeout(() => {
      expired = true
      report(false)
    }, timeoutMs)
    try {
      await probe()
      if (!expired) report(!isStopping())
    } catch {
      if (!expired) report(false)
    } finally {
      clearTimeout(timeout)
      // Release only when actual I/O settles. Late success must not restore ready.
      checking = false
    }
  }
}

let graceMs = 25000
async function main() {
  if (process.argv.length !== 2) throw new Error('staging-runtime takes no arguments')
  if (env.NODE_ENV !== 'production') throw new Error('Staging requires NODE_ENV=production')
  if (env.STAGING_REPLICAS !== '1') throw new Error('STAGING_REPLICAS must attest to one replica')
  graceMs = integer('STAGING_SHUTDOWN_MS', 25000, 1000, 120000)
  const apiPort = integer('STAGING_API_PORT', 3001, 1024, 65535)
  const healthPort = integer('PORT', 3002, 1024, 65535)
  if (apiPort === healthPort) throw new Error('API and readiness ports must differ')
  const scripts = [
    ['api', 'STAGING_API_SCRIPT', 'server.js', 'dist'],
    ['daily-settlement', 'STAGING_DAILY_SCRIPT', 'daily-settlement-worker.mjs', 'scripts'],
    ['api-settlement', 'STAGING_SETTLEMENT_SCRIPT', 'api-settlement-worker.mjs', 'scripts'],
    ['video', 'STAGING_VIDEO_SCRIPT', 'video-job-worker.mjs', 'scripts'],
  ]
  for (const [, key, basename] of scripts) {
    // Root basename only, exact allowlist; never shell commands, paths or flags.
    if (env[key] !== undefined && env[key] !== basename) throw new Error(`Invalid ${key}`)
  }
  const payments = flag('STAGING_PAYMENTS_ENABLED')
  if (!payments) {
    for (const key of Object.keys(env)) if (key.startsWith('STRIPE_')) delete env[key]
    env.STRIPE_CHECKOUT_ENABLED = 'false'
    env.STRIPE_FULFILLMENT_ENABLED = 'false'
  } else {
    if (!/^sk_test_[A-Za-z0-9]+$/.test(env.STRIPE_SECRET_KEY || '') || !/^whsec_[A-Za-z0-9]+$/.test(env.STRIPE_WEBHOOK_SECRET || '') ||
        env.STRIPE_MODE !== 'test' || (env.STRIPE_WEBHOOK_ACCOUNT !== 'platform' && !/^acct_[A-Za-z0-9]+$/.test(env.STRIPE_WEBHOOK_ACCOUNT || ''))) {
      throw new Error('Staging payments require test-mode ingress configuration')
    }
    flag('STRIPE_CHECKOUT_ENABLED')
    flag('STRIPE_FULFILLMENT_ENABLED')
  }
  const video = flag('ACCOUNTED_VIDEO_JOBS_ENABLED')
  const dailyVideo = flag('ACCOUNTED_DAILY_VIDEO_JOBS_ENABLED')
  if (dailyVideo && !video) throw new Error('Daily video requires accounted video')
  // Legacy direct-video tools must remain off in this candidate.
  for (const key of ['VIDEO_API_URL', 'HF_VIDEO_ENDPOINT_URL']) delete env[key]
  if (!video) delete env.HF_VIDEO_ENDPOINT
  if (env.PRIVATE_FILES_STORAGE_MODE !== 'shared-filesystem' || env.PRIVATE_FILES_DIR !== '/private-store/files') {
    throw new Error('Mount the dedicated PVC at /private-store; PRIVATE_FILES_DIR must be /private-store/files')
  }
  require('../dist/middleware/envValidation.js').validateEnv(env)
  // Services read process.env. Synchronize the gated child environment before imports.
  for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key]
  Object.assign(process.env, env)
  const storage = require('../dist/services/privateStorage.js')
  ;({ prisma } = require('../dist/services/prisma.js'))
  if (!prisma) throw new Error('A staging database is required')
  process.on('SIGTERM', () => shutdown())
  process.on('SIGINT', () => shutdown())
  await storage.checkPrivateStorageReadiness(0, env)
  if (stopping) return
  await childProcess('preflight', 'node_modules/prisma/build/index.js', ['migrate', 'status'])
  if (stopping) return

  const check = createReadinessCheck({
    isStopping: () => stopping,
    report: (ok) => {
      ready = ok && !stopping && children.size === 4
      checkedAt = Date.now()
    },
    probe: async () => {
      await storage.checkPrivateStorageReadiness(0, env)
      await prisma.$queryRawUnsafe('SELECT 1')
      const response = await fetch(`http://127.0.0.1:${apiPort}/health`, { signal: AbortSignal.timeout(2500) })
      if (!response.ok) throw new Error('API unavailable')
      await response.arrayBuffer()
    },
  })
  server = createServer((req, res) => {
    const ok = !stopping && ready && Date.now() - checkedAt < 20000 && children.size === 4
    res.writeHead(req.url === '/ready' ? (ok ? 200 : 503) : 404, {
      'Content-Type': 'application/json', 'Cache-Control': 'no-store',
    })
    res.end(JSON.stringify(req.url === '/ready' ? { ready: ok } : { error: 'Not found' }))
  })
  server.on('error', () => shutdown(true))
  // Dual stack is required for Railway private IPv6 networking.
  server.listen({ port: healthPort, host: '::', ipv6Only: false })
  for (const [name, , basename, folder] of scripts) {
    if (stopping) break
    void childProcess(name, name === 'api' ? 'scripts/staging-runtime.mjs' : `${folder}/${basename}`,
      name === 'api' ? ['--api-child'] : [], { ...env, PORT: String(apiPort) }).catch(() => shutdown(true))
  }
  interval = setInterval(() => { void check() }, 10000)
  void check()
  console.log('[staging] supervisor started; API plus three essential workers, one PVC, one replica')
}

async function apiChild() {
  // Capture the API's HTTP server without editing shared server.ts. Drain open
  // requests on SIGTERM; the parent bounds long streams with its grace timeout.
  const servers = new Set()
  const listen = Server.prototype.listen
  Server.prototype.listen = function (...args) {
    servers.add(this)
    return listen.apply(this, args)
  }
  require('../dist/server.js')
  Server.prototype.listen = listen
  let draining = false
  const stop = async () => {
    if (draining) return
    draining = true
    await Promise.all([...servers].map((server) => new Promise((done) => {
      server.close(done)
      server.closeIdleConnections()
    })))
    await require('../dist/services/prisma.js').prisma?.$disconnect()
    process.exit(0)
  }
  process.on('SIGTERM', () => { void stop().catch(() => process.exit(1)) })
  process.on('SIGINT', () => { void stop().catch(() => process.exit(1)) })
}

// Importable for isolated supervisor regressions without starting services.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  (process.argv.length === 3 && process.argv[2] === '--api-child' ? apiChild() : main()).catch(() => {
    // Configuration error messages are authored above or by validateEnv; never dump environment/DB errors.
    console.error('[staging] startup failed; verify configuration, migration status, and private storage')
    shutdown(true)
  })
}
