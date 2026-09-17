import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { createReadinessCheck } from '../../backend/scripts/staging-runtime.mjs'
import { cleanupSmoke, withSmokeCleanup } from './smoke-lifecycle.mjs'

for (const outcome of ['resolve', 'reject']) {
  test(`timed-out probe cannot overlap; late ${outcome} stays unready until a fresh check`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    let complete, fail, calls = 0
    const stalled = new Promise((resolve, reject) => { complete = resolve; fail = reject })
    const reports = []
    const check = createReadinessCheck({
      probe: () => { calls++; return calls === 1 ? stalled : Promise.resolve() },
      report: (ok) => reports.push(ok), isStopping: () => false,
    })
    const first = check()
    await check()
    assert.equal(calls, 1)
    t.mock.timers.tick(5000)
    assert.deepEqual(reports, [false])
    for (let i = 0; i < 10; i++) { t.mock.timers.tick(10000); await check() }
    assert.equal(calls, 1, 'Deadline must not release the in-flight I/O guard')
    if (outcome === 'resolve') complete()
    else fail(new Error('Synthetic probe failure'))
    await first
    assert.deepEqual(reports, [false], 'Late completion must not publish success')
    await check()
    assert.equal(calls, 2)
    assert.deepEqual(reports, [false, true])
  })
}

test('normal success and failure release guard and cancel deadline', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let calls = 0
  const reports = []
  const check = createReadinessCheck({
    probe: async () => { if (++calls === 2) throw new Error('Synthetic failure') },
    report: (ok) => reports.push(ok), isStopping: () => false,
  })
  await check(); await check(); await check()
  t.mock.timers.tick(10000)
  assert.deepEqual(reports, [true, false, true])
})

test('shutdown prevents new probes and late readiness success', async () => {
  let stopping = false, complete, calls = 0
  const reports = []
  const check = createReadinessCheck({
    probe: () => { calls++; return new Promise((resolve) => { complete = resolve }) },
    report: (ok) => reports.push(ok), isStopping: () => stopping,
  })
  const pending = check()
  stopping = true
  complete()
  await pending
  await check()
  assert.equal(calls, 1)
  assert.deepEqual(reports, [false])
})

test('success is emitted only after successful cleanup', async () => {
  const order = []
  await withSmokeCleanup({ run: () => order.push('run'), cleanup: async () => {
    await Promise.resolve(); order.push('cleanup')
  }, onSuccess: () => order.push('success') })
  assert.deepEqual(order, ['run', 'cleanup', 'success'])
})

test('cleanup runs after smoke failure; both errors are preserved', async () => {
  const runError = new Error('Synthetic smoke failure'), cleanupError = new Error('Synthetic cleanup failure')
  let cleaned = false, success = false
  await assert.rejects(withSmokeCleanup({
    run: () => { throw runError }, cleanup: () => { cleaned = true; throw cleanupError },
    onSuccess: () => { success = true },
  }), (error) => error instanceof AggregateError && error.errors[0] === runError && error.errors[1] === cleanupError)
  assert.equal(cleaned, true)
  assert.equal(success, false)
})

for (const failedPhase of ['run', 'cleanup']) {
  test(`${failedPhase} failure exits a real smoke driver nonzero without creating resources`, () => {
    const module = new URL('./smoke-lifecycle.mjs', import.meta.url).href
    const script = `import { withSmokeCleanup } from ${JSON.stringify(module)};
      await withSmokeCleanup({
        run: () => { ${failedPhase === 'run' ? "throw new Error('Synthetic run failure')" : ''} },
        cleanup: () => { console.log('CLEANUP_ATTEMPTED'); ${failedPhase === 'cleanup' ? "throw new Error('Synthetic cleanup failure')" : ''} },
        onSuccess: () => console.log('UNEXPECTED_SUCCESS')
      });`
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 10000 })
    assert.equal(result.status, 1)
    assert.match(result.stdout, /CLEANUP_ATTEMPTED/)
    assert.doesNotMatch(result.stdout, /UNEXPECTED_SUCCESS/)
  })
}

test('cleanup discovers only owned labels and succeeds for already absent resources', async () => {
  const calls = [], project = 'owned-smoke-synthetic'
  await cleanupSmoke({ project, compose: ['compose', '-p', project], docker: (args) => {
    calls.push(args)
    if (args[0] !== 'compose') assert.ok(args.includes('--filter') && args.some((arg) => arg.endsWith(`=${project}`)))
    return ''
  } })
  assert.equal(calls.length, 9)
  assert.ok(calls.some((args) => args.includes('--volumes')))
})

test('failed removal still attempts other cleanup and verifies all owned resource kinds', async () => {
  const calls = [], project = 'owned-smoke-synthetic'
  await assert.rejects(cleanupSmoke({ project, compose: ['compose', '-p', project], docker: (args) => {
    calls.push(args)
    if (args[0] === 'ps' && args.includes(`label=loop.owned-smoke=${project}`)) return 'synthetic-container'
    if (args[0] === 'rm') throw new Error('Synthetic Docker failure')
    return ''
  } }), AggregateError)
  assert.ok(calls.some((args) => args[0] === 'compose'))
  assert.equal(calls.filter((args) => args[0] === 'volume').length, 2)
})

test('successful removal commands with residual resources still fail cleanup', async () => {
  let volumes = 0
  await assert.rejects(cleanupSmoke({ project: 'owned-smoke-synthetic', compose: ['compose'], docker: (args) => {
    if (args[0] === 'volume') { volumes++; return 'synthetic-residual-volume' }
    return ''
  } }), AggregateError)
  assert.equal(volumes, 2)
})
