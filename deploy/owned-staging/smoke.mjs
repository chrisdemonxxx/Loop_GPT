// Operator-invoked LOCAL Docker smoke. Ephemeral credentials exist only in child
// environment; unique Compose project/volumes are removed in finally. No Railway.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import { cleanupSmoke, withSmokeCleanup } from './smoke-lifecycle.mjs'
import { checkDockerContexts } from './docker-context-smoke.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const project = `owned-smoke-${randomBytes(5).toString('hex')}`
const network = `${project}-proxy`
const backendFixture = `${project}-fixture`, webFixture = `${project}-web`
const fixtureLabel = `loop.owned-smoke=${project}`
async function freePort() {
  const server = createServer()
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  const port = server.address().port
  await new Promise((done) => server.close(done))
  return String(port)
}
const env = {
  ...process.env,
  STAGING_DB_PASSWORD: randomBytes(24).toString('hex'),
  STAGING_JWT_SECRET: randomBytes(32).toString('hex'),
  STAGING_CONNECTION_KEY: randomBytes(32).toString('base64'),
  STAGING_STORE_ID: randomUUID(),
  OWNED_WEB_ORIGIN: 'https://owned-smoke.example.invalid',
  STAGING_WEB_PORT: await freePort(), STAGING_READY_PORT: await freePort(),
}
const compose = ['compose', '-p', project, '-f', 'deploy/owned-staging/compose.yaml']
function docker(args, expected = 0, expectedError) {
  const result = spawnSync('docker', args, { cwd: root, env, encoding: 'utf8', timeout: 240000, maxBuffer: 8 * 1024 * 1024 })
  if (result.status !== expected) {
    // Scrub generated secrets before printing diagnostic output.
    let output = `${result.stdout || ''}\n${result.stderr || ''}`
    for (const key of ['STAGING_DB_PASSWORD', 'STAGING_JWT_SECRET', 'STAGING_CONNECTION_KEY']) output = output.replaceAll(env[key], '[redacted]')
    throw new Error(`Docker command failed (${result.status}, expected ${expected})\n${output}`)
  }
  if (expectedError) assert.ok(expectedError.test(result.stderr || ''), 'Expected early operator configuration rejection')
  return result.stdout.trim()
}
const dc = (...args) => docker([...compose, ...args])
const once = (service, ...args) => dc('run', '--rm', '--no-deps', service, ...args)
async function response(url, options) { return fetch(url, { ...options, signal: options?.signal ?? AbortSignal.timeout(5000) }) }
async function waitHttp(url) {
  for (let i = 0; i < 60; i++) {
    try { if ((await response(url)).ok) return } catch {}
    await delay(500)
  }
  throw new Error(`Local readiness timed out: ${url}`)
}

await withSmokeCleanup({ run: async () => {
  console.log(`LOCAL smoke project: ${project}`)
  const regressions = spawnSync(process.execPath, ['--test', 'deploy/owned-staging/regressions.test.mjs'], { cwd: root, stdio: 'inherit' })
  assert.equal(regressions.status, 0, 'Focused packaging regressions must pass')
  if (process.argv.includes('--build')) dc('build', 'backend', 'web')
  checkDockerContexts(project)
  dc('config', '--quiet')
  dc('up', '-d', '--wait', 'postgres')
  docker([...compose, 'run', '--rm', '--no-deps', 'backend'], 1)
  console.log('PASS: runtime refuses an uninitialized PVC')
  once('storage-prepare')
  once('storage-init', 'node', '-e', `
    const fs=require('node:fs'),{spawnSync}=require('node:child_process'),assert=require('node:assert/strict');
    const p='/private-store/files/foreign';fs.writeFileSync(p,'unidentified fixture');
    const r=spawnSync(process.execPath,['scripts/private-storage.mjs','--init']);
    assert.equal(r.status,1);assert.equal(fs.existsSync('/private-store/files/.loop-private-store.json'),false);fs.unlinkSync(p);
  `)
  console.log('PASS: --init rejects an unidentified nonempty namespace')
  once('storage-init')
  once('storage-init')
  once('storage-check')
  docker([...compose, 'run', '--rm', '--no-deps', '-e', `PRIVATE_FILES_STORE_ID=${randomUUID()}`, 'storage-check'], 1)
  docker([...compose, 'run', '--rm', '--no-deps', '-e', 'STAGING_API_SCRIPT=../server.js', 'backend'], 1)
  // Before migrate deploy, status must fail and the API must not start.
  docker([...compose, 'run', '--rm', '--no-deps', 'backend'], 1)
  once('migrate')
  dc('up', '-d', '--wait', '--wait-timeout', '120', 'backend', 'web')
  const base = `http://127.0.0.1:${env.STAGING_WEB_PORT}`
  await waitHttp(`http://127.0.0.1:${env.STAGING_READY_PORT}/ready`)
  const html = await response(`${base}/`)
  assert.equal(html.status, 200)
  assert.equal(html.headers.get('cache-control'), 'no-cache')
  assert.equal(html.headers.get('x-content-type-options'), 'nosniff')
  assert.ok(html.headers.get('content-security-policy').includes("connect-src 'self'"))
  const text = await html.text()
  const asset = text.match(/src="(\/assets\/[^" ]+\.js)"/)[1]
  assert.match((await response(base + asset)).headers.get('cache-control'), /immutable/)
  assert.equal((await response(`${base}/assets/missing.js`)).status, 404)
  assert.equal((await response(`${base}/sw.js`)).headers.get('cache-control'), 'no-cache')
  assert.match((await response(`${base}/manifest.webmanifest`)).headers.get('content-type'), /application\/manifest\+json/)
  assert.match(await (await response(`${base}/workspace/fixture`)).text(), /<html/)
  const config = await response(`${base}/api/billing/config`)
  assert.equal(config.headers.get('cache-control'), 'no-store')
  const billing = await config.json()
  assert.equal(billing.enabled, false)
  assert.equal(billing.checkoutEnabled, false)
  assert.equal(billing.fulfillmentEnabled, false)
  dc('exec', '-T', 'backend', 'node', '-e', `
    const fs=require('node:fs'),assert=require('node:assert/strict');
    assert.equal(fs.existsSync('/app/.env'),false);
    const pids=fs.readdirSync('/proc').filter(x=>/^\\d+$/.test(x));
    const commands=pids.map(x=>{try{return fs.readFileSync('/proc/'+x+'/cmdline','utf8')}catch{return ''}});
    for(const name of ['--api-child','daily-settlement-worker.mjs','api-settlement-worker.mjs','video-job-worker.mjs'])
      assert.ok(commands.some(c=>c.includes(name)));
  `)
  console.log('PASS: migrations, four-child runtime, DB/storage/API readiness, disabled payments, static/PWA headers and SPA')

  // Readiness must degrade on a namespace identity mismatch and recover without
  // ever re-initializing or replacing the marker at startup.
  dc('exec', '-T', 'backend', 'node', '-e', `require('node:fs').renameSync('/private-store/files/.loop-private-store.json','/private-store/files/marker-smoke-backup')`)
  await delay(11000)
  assert.equal((await response(`http://127.0.0.1:${env.STAGING_READY_PORT}/ready`)).status, 503)
  dc('exec', '-T', 'backend', 'node', '-e', `require('node:fs').renameSync('/private-store/files/marker-smoke-backup','/private-store/files/.loop-private-store.json')`)
  await waitHttp(`http://127.0.0.1:${env.STAGING_READY_PORT}/ready`)
  console.log('PASS: UUID mismatch and script-path rejection; readiness degrades/rechecks storage')

  // Separate mock upstream proves streaming/proxy behavior without provider calls.
  docker(['network', 'create', '--label', fixtureLabel, network])
  docker(['run', '-d', '--label', fixtureLabel, '--name', backendFixture, '--network', network, '--network-alias', 'backend',
    '--mount', `type=bind,source=${fileURLToPath(new URL('./proxy-fixture.mjs', import.meta.url))},target=/fixture.mjs,readonly`,
    'loop-owned-staging-backend:local', 'node', '/fixture.mjs'])
  const fixturePort = await freePort()
  docker(['run', '-d', '--label', fixtureLabel, '--name', webFixture, '--network', network, '-p', `127.0.0.1:${fixturePort}:8080`,
    '-e', 'API_UPSTREAM=http://backend:3001', '-e', 'OWNED_WEB_ORIGIN=https://fixture.example.invalid', 'loop-owned-staging-web:local'])
  const fixtureBase = `http://127.0.0.1:${fixturePort}`
  await waitHttp(`${fixtureBase}/healthz`)
  const echo = await (await response(`${fixtureBase}/api/echo?target=https://untrusted.invalid`, {
    method: 'POST', headers: { authorization: 'Bearer nonsecret-fixture', origin: 'https://untrusted.invalid' }, body: 'fixture-body',
  })).json()
  assert.equal(echo.host, 'backend:3001')
  assert.equal(echo.authorization, 'Bearer nonsecret-fixture')
  assert.equal(echo.body, 'fixture-body')
  const start = Date.now()
  const stream = await response(`${fixtureBase}/api/stream`, { method: 'POST', body: '{}' })
  const reader = stream.body.getReader()
  assert.match(new TextDecoder().decode((await reader.read()).value), /first/)
  assert.ok(Date.now() - start < 1200, 'SSE first frame must arrive before delayed final frame')
  await reader.cancel()
  await delay(200)
  assert.equal((await (await response(`${fixtureBase}/api/disconnected`)).json()).disconnected, true)
  // The developer API is a separate nginx location; prove it forwards the same
  // way and streams SSE without buffering (the chat path's real risk).
  const v1echo = await (await response(`${fixtureBase}/v1/echo?target=https://untrusted.invalid`, {
    method: 'POST', headers: { authorization: 'Bearer nonsecret-fixture', origin: 'https://untrusted.invalid' }, body: 'v1-fixture-body',
  })).json()
  assert.equal(v1echo.host, 'backend:3001')
  assert.equal(v1echo.authorization, 'Bearer nonsecret-fixture')
  assert.equal(v1echo.body, 'v1-fixture-body')
  assert.ok(String(v1echo.url).startsWith('/v1/echo'), '/v1 path must be forwarded verbatim')
  const v1start = Date.now()
  const v1stream = await response(`${fixtureBase}/v1/stream`, { method: 'POST', body: '{}' })
  const v1reader = v1stream.body.getReader()
  assert.match(new TextDecoder().decode((await v1reader.read()).value), /first/)
  assert.ok(Date.now() - v1start < 1200, '/v1 SSE first frame must arrive before delayed final frame')
  await v1reader.cancel()
  docker(['restart', webFixture])
  await waitHttp(`${fixtureBase}/healthz`)
  docker(['run', '--rm', '--network', 'none', '--label', fixtureLabel, '-e', 'API_UPSTREAM=https://good.invalid;include /tmp/evil;',
    '-e', 'OWNED_WEB_ORIGIN=https://fixture.example.invalid', 'loop-owned-staging-web:local'], 1)
  // Pass values via the child environment: preserve CR/LF even on Windows argv.
  for (const key of ['API_UPSTREAM', 'OWNED_WEB_ORIGIN', 'PORT']) {
    for (const separator of ['\r', '\n', '\r\n']) {
      const values = { API_UPSTREAM: 'https://good.invalid', OWNED_WEB_ORIGIN: 'https://fixture.example.invalid', PORT: '8080' }
      values[key] += `${separator}invalid-tail`
      const previous = Object.fromEntries(Object.keys(values).map((name) => [name, env[name]]))
      Object.assign(env, values)
      try {
        docker(['run', '--rm', '--network', 'none', '--label', fixtureLabel,
          '-e', 'API_UPSTREAM', '-e', 'OWNED_WEB_ORIGIN', '-e', 'PORT', 'loop-owned-staging-web:local'], 1,
          /Invalid owned-web operator configuration/)
      } finally {
        for (const [name, value] of Object.entries(previous)) {
          if (value === undefined) delete env[name]
          else env[name] = value
        }
      }
    }
  }
  console.log('PASS: fixed upstream, POST/auth/query forwarding, /v1 forwarding, early SSE frames (/api and /v1), disconnect propagation, restart, injection rejection')

  // An exited essential worker must terminate the WHOLE container nonzero.
  const id = dc('ps', '-q', 'backend')
  dc('exec', '-T', 'backend', 'node', '-e', `
    const fs=require('node:fs');
    for(const id of fs.readdirSync('/proc').filter(x=>/^\\d+$/.test(x))){
      if(+id===process.pid)continue;
      try{const c=fs.readFileSync('/proc/'+id+'/cmdline','utf8');if(c.startsWith('/usr/local/bin/node\\0/app/scripts/api-settlement-worker.mjs'))process.kill(+id,'SIGTERM')}catch{}
    }
  `)
  assert.equal(docker(['wait', id]), '1')
  dc('up', '-d', '--wait', '--wait-timeout', '120', 'backend')
  dc('stop', 'backend')
  assert.equal(docker(['inspect', '-f', '{{.State.ExitCode}}', id]), '0')
  console.log('PASS: essential-child exit fails container; ordinary SIGTERM drains to exit 0')
}, cleanup: () => cleanupSmoke({ docker, compose, project }), onSuccess: () => {
  console.log(`PASS: cleanup verified; no containers, networks or volumes remain for ${project}`)
  console.log('LOCAL PACKAGING SMOKE PASSED; no deployment or live-provider qualification performed.')
} })
