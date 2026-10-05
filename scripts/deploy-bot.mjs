#!/usr/bin/env node
/**
 * One-command bot-computer release (workstream C6).
 *
 * Wraps the exact reviewed release sequence:
 *   1. backend build + unit tests
 *   2. frontend build
 *   3. git push (Railway auto-deploys)
 *   4. migration release: `railway connect postgres --tunnel-only` local SSH
 *      tunnel -> `prisma migrate deploy` -> tunnel closed
 *
 * The supervisor's startup migration preflight remains the fail-closed backstop
 * if this script's migration step is ever skipped.
 *
 * Usage:  node scripts/deploy-bot.mjs [--skip-tests] [--skip-migrate]
 * Requires: the Railway CLI logged in, the ai-ops-fleet SSH key registered,
 * and an authenticated git remote for the release branch.
 */
import { spawn, spawnSync } from 'node:child_process'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PROJECT = '8584f5ac-2000-4311-9dae-ae283b70216f'
const ENVIRONMENT = '2faec73c-12aa-47c9-9a6c-94a9276eb6d5'

/** Grab an ephemeral free local port for the tunnel (a fixed port collides
 *  with orphaned tunnels from killed runs — that exact failure happened). */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.listen(0, '127.0.0.1', () => { const port = (server.address() as net.AddressInfo).port; server.close(() => resolve(port)) })
    server.on('error', reject)
  })
}

const args = new Set(process.argv.slice(2))
const say = (step, msg) => console.log(`\n[deploy] ${step}: ${msg}`)

function run(cmd, cwd = ROOT, env = {}) {
  const result = spawnSync(cmd, { cwd, shell: true, stdio: 'inherit', env: { ...process.env, ...env } })
  if (result.status !== 0) { console.error(`[deploy] FAILED: ${cmd} (exit ${result.status})`); process.exit(1) }
}

function waitForPort(port, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = net.connect(port, '127.0.0.1')
      socket.once('connect', () => { socket.destroy(); resolve() })
      socket.once('error', () => {
        socket.destroy()
        if (Date.now() > deadline) reject(new Error(`tunnel port ${port} never opened`))
        else setTimeout(attempt, 1000)
      })
    }
    attempt()
  })
}

async function main() {
  const branch = spawnSync('git', ['branch', '--show-current'], { cwd: ROOT, shell: true, encoding: 'utf8' }).stdout?.trim()
  if (branch !== 'release/owned-staging-20260917') {
    console.error(`[deploy] Refusing: current branch is "${branch}", expected release/owned-staging-20260917.`)
    process.exit(1)
  }

  say('1/5', 'backend build + unit tests')
  run('npm run build', path.join(ROOT, 'backend'))
  if (!args.has('--skip-tests')) run('npm test', path.join(ROOT, 'backend'))

  say('2/5', 'frontend build')
  run('npm run build', path.join(ROOT, 'frontend'))

  say('3/5', 'frontend build')
  run('npm run build', path.join(ROOT, 'frontend'))

  // Migrations BEFORE the push: the supervisor's startup preflight fails the
  // deployment closed when a migration is pending, so the schema must land
  // before the code that needs it auto-deploys.
  if (args.has('--skip-migrate')) {
    say('4/5', 'migrations SKIPPED by flag — the supervisor preflight will stop startup if any are pending')
  } else {
    say('4/5', 'migration release through the local SSH tunnel')
    const tunnelPort = await freePort()
    const vars = spawnSync('railway', ['variables', '--service', 'postgres', '--project', PROJECT, '--environment', ENVIRONMENT, '--kv'],
      { cwd: ROOT, shell: true, encoding: 'utf8' })
    if (vars.status !== 0) { console.error('[deploy] FAILED: could not read postgres variables'); process.exit(1) }
    const dbUrl = (vars.stdout.match(/^DATABASE_URL=(.+)$/m) || [])[1]
    const user = (vars.stdout.match(/^POSTGRES_USER=(.+)$/m) || [])[1]
    const pass = (vars.stdout.match(/^POSTGRES_PASSWORD=(.+)$/m) || [])[1]
    const name = (vars.stdout.match(/^POSTGRES_DB=(.+)$/m) || [])[1]
    if (!dbUrl && !(user && pass && name)) { console.error('[deploy] FAILED: no DATABASE_URL or POSTGRES_* credentials found'); process.exit(1) }
    const tunnel = spawn('railway', ['connect', 'postgres', '--tunnel-only', '--ssh', '-P', String(tunnelPort), '--project', PROJECT, '--environment', ENVIRONMENT],
      { cwd: ROOT, shell: true, stdio: ['ignore', 'inherit', 'inherit'] })
    try {
      await waitForPort(tunnelPort)
      const local = dbUrl
        ? dbUrl.replace(/@[^:/]+:\d+/, '@127.0.0.1:' + tunnelPort)
        : `postgresql://${user}:${pass}@127.0.0.1:${tunnelPort}/${name}`
      run('npx prisma migrate deploy', path.join(ROOT, 'backend'), { DATABASE_URL: local })
    } finally {
      tunnel.kill()
    }
  }

  say('5/5', `git push origin ${branch} — Railway auto-deploys with the schema already in place`)
  run('git push origin release/owned-staging-20260917')
}
}

main().catch((error) => { console.error(`[deploy] ${error.message}`); process.exit(1) })
