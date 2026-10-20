#!/usr/bin/env node
/**
 * Live E2B smoke for bot computer parity (Grok-feel gate).
 *
 * Modes:
 *   Default (no BOT_LIVE): skip cleanly (exit 0) when E2B_API_KEY is unset so
 *     CI/local unit suites never require a provider account.
 *   BOT_LIVE=1: FAIL (exit 1) if E2B_API_KEY is unset. Requires a real key and
 *     exercises provider + (when configured) full API stages.
 *
 * Provider stages (always with key):
 *   1. Cold-boot desktop (E2B_DESKTOP_TEMPLATE / BOT_E2B_TEMPLATE)
 *   2. Start VNC stream + auth key
 *   3. Pause → connect same sandbox id (always-on feel)
 *   4. Kill
 *
 * API stages (BOT_SMOKE_API_URL + BOT_SMOKE_TOKEN):
 *   wake, ws-token, file R/W, computer task, takeover, teach→skill list
 *
 * With BOT_LIVE=1, missing API URL/token fails (not skips) so the gate is honest.
 *
 * Usage:
 *   node scripts/bot-live-smoke.mjs
 *   BOT_LIVE=1 node scripts/bot-live-smoke.mjs
 *   BOT_LIVE=1 BOT_SMOKE_API_URL=http://127.0.0.1:4000 BOT_SMOKE_TOKEN=… node scripts/bot-live-smoke.mjs
 */

const LIVE = process.env.BOT_LIVE === '1' || process.env.BOT_LIVE === 'true'

function skip(reason) {
  if (LIVE) {
    console.error(`[bot-live-smoke] FAIL (BOT_LIVE=1): ${reason}`)
    process.exit(1)
  }
  console.log(`[bot-live-smoke] skipped: ${reason}`)
  process.exit(0)
}

function fail(message, err) {
  console.error(`[bot-live-smoke] FAIL: ${message}`)
  if (err) console.error(err)
  process.exit(1)
}

function ok(step, detail = '') {
  console.log(`[bot-live-smoke] ✓ ${step}${detail ? ` — ${detail}` : ''}`)
}

async function providerSmoke() {
  const key = process.env.E2B_API_KEY
  if (!key) skip('E2B_API_KEY unset')

  let Sandbox
  try {
    ;({ Sandbox } = await import('@e2b/desktop'))
  } catch (err) {
    fail('could not import @e2b/desktop', err)
  }

  const template =
    process.env.E2B_DESKTOP_TEMPLATE ||
    process.env.BOT_E2B_TEMPLATE ||
    process.env.E2B_TEMPLATE ||
    undefined

  if (LIVE && !template) {
    fail('BOT_LIVE=1 requires E2B_DESKTOP_TEMPLATE (GNOME image from infra/e2b-gnome-desktop)')
  }

  console.log(`[bot-live-smoke] creating desktop sandbox${template ? ` (template=${template})` : ''}…`)
  const createOpts = {
    timeoutMs: 180_000,
    lifecycle: { onTimeout: 'pause', autoResume: true },
    metadata: { loopGpt: 'bot-smoke' },
  }
  const sandbox = template
    ? await Sandbox.create(template, createOpts)
    : await Sandbox.create(createOpts)
  const sandboxId = String(sandbox.sandboxId)
  ok('create', `sandbox=${sandboxId}`)

  let paused = false
  try {
    // Stream ping
    try {
      await sandbox.stream.start({ requireAuth: true })
    } catch (e) {
      if (!/already running/i.test(String(e?.message || e))) throw e
    }
    const authKey = String(sandbox.stream.getAuthKey?.() || '')
    if (!authKey) fail('stream started but auth key was empty')
    ok('stream', `authKey length=${authKey.length}`)

    // Optional GNOME binary check when using our template
    if (template) {
      const gnome = await sandbox.commands.run(
        'test -x /usr/bin/gnome-shell -a -x /usr/bin/gnome-session',
        { timeoutMs: 10_000 },
      ).catch(() => null)
      if (!gnome || (gnome.exitCode ?? 1) !== 0) {
        fail('GNOME binaries missing from template — rebuild infra/e2b-gnome-desktop')
      }
      ok('gnome-binaries')
    }

    // Marker before pause — must still exist after connect (same machine).
    const marker = `smoke-${Date.now()}`
    await sandbox.commands.run(`echo ${marker} > /tmp/.bot-live-smoke`, { timeoutMs: 20_000 })

    // Pause → wake same id (provider always-on feel)
    const pauseFn = Sandbox.pause || Sandbox.betaPause
    if (typeof pauseFn !== 'function') {
      fail('Sandbox.pause / betaPause missing from @e2b/desktop SDK')
    }
    await pauseFn.call(Sandbox, sandboxId)
    paused = true
    ok('pause', sandboxId)

    const resumed = await Sandbox.connect(sandboxId)
    if (String(resumed.sandboxId) !== sandboxId) {
      fail(`pause/wake returned different sandbox id: ${resumed.sandboxId} ≠ ${sandboxId}`)
    }
    const check = await resumed.commands.run('cat /tmp/.bot-live-smoke', { timeoutMs: 20_000 })
    const got = String(check.stdout || '').trim()
    if (got !== marker) {
      fail(`pause/wake lost disk state: expected ${marker}, got ${got || '(empty)'}`)
    }
    ok('wake-same-id', sandboxId)

    await resumed.kill().catch(() => undefined)
    paused = false
    ok('kill', sandboxId)
  } finally {
    if (!paused) {
      await sandbox.kill().catch(() => undefined)
    } else {
      try {
        const h = await Sandbox.connect(sandboxId)
        await h.kill().catch(() => undefined)
      } catch {
        /* already gone */
      }
    }
  }
}

async function apiSmoke(apiUrl, token) {
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  }

  // --- wake ---
  const wake = await fetch(`${apiUrl}/api/bot/computer/wake`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ taskType: 'default' }),
  })
  if (!wake.ok) {
    const body = await wake.text()
    fail(`POST /computer/wake → ${wake.status}: ${body}`)
  }
  const box = await wake.json()
  if (!box.sandboxId) fail('wake response missing sandboxId')
  ok('api-wake', `sandboxId=${box.sandboxId} resumed=${box.resumed}`)

  // --- ws-token (stream auth gate) ---
  const tok = await fetch(`${apiUrl}/api/bot/computer/ws-token`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ sandboxId: box.sandboxId }),
  })
  if (!tok.ok) fail(`POST /computer/ws-token → ${tok.status}`)
  const minted = await tok.json()
  if (!minted.token || minted.queryParam !== 'token') fail('ws-token shape unexpected')
  ok('api-ws-token', `expiresIn=${minted.expiresIn}`)

  // --- file R/W ---
  const smokePath = `/workspace/.bot-live-smoke-${Date.now()}.txt`
  const put = await fetch(`${apiUrl}/api/bot/computer/file`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({ path: smokePath, content: 'bot-live-smoke write\n' }),
  })
  if (!put.ok) fail(`PUT /computer/file → ${put.status}: ${await put.text()}`)
  const get = await fetch(`${apiUrl}/api/bot/computer/file?path=${encodeURIComponent(smokePath)}`, { headers })
  if (!get.ok) fail(`GET /computer/file → ${get.status}`)
  const fileBody = await get.json()
  const content = typeof fileBody === 'string' ? fileBody : (fileBody.content || fileBody.text || '')
  if (!String(content).includes('bot-live-smoke write')) {
    fail(`file R/W mismatch: ${JSON.stringify(fileBody).slice(0, 200)}`)
  }
  ok('api-file-rw', smokePath)

  const files = await fetch(`${apiUrl}/api/bot/computer/files?path=${encodeURIComponent('/workspace')}`, { headers })
  if (!files.ok) fail(`GET /computer/files → ${files.status}`)
  ok('api-files-list')

  // --- computer task ---
  const enqueue = await fetch(`${apiUrl}/api/bot/tasks`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      goal: 'bot-live-smoke computer ping — reply with the word ok and stop.',
      maxSteps: 2,
      computer: { enabled: true, ttlMinutes: 10 },
    }),
  })
  if (!enqueue.ok) fail(`POST /tasks (computer) → ${enqueue.status}: ${await enqueue.text()}`)
  const taskPayload = await enqueue.json()
  const taskId = taskPayload?.task?.id || taskPayload?.id
  if (!taskId) fail('computer task enqueue missing id')
  ok('api-computer-task', `taskId=${taskId}`)

  // Poll briefly for a run id so takeover can be exercised
  let runId = null
  for (let i = 0; i < 30 && !runId; i += 1) {
    await new Promise((r) => setTimeout(r, 1000))
    const detail = await fetch(`${apiUrl}/api/bot/tasks/${taskId}`, { headers })
    if (!detail.ok) continue
    const t = await detail.json()
    runId = t?.runs?.[0]?.id || t?.task?.runs?.[0]?.id || t?.runId || null
  }

  if (runId) {
    const take = await fetch(`${apiUrl}/api/bot/runs/${runId}/takeover`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ takeover: true }),
    })
    let takeoverActive = false
    if (!take.ok) {
      const body = await take.text()
      // Short smoke goals often finish before we poll a run id — 409 "not active" is expected then.
      if (take.status === 409 && /not active/i.test(body)) {
        ok('api-takeover', `runId=${runId} (skipped — run already finished)`)
      } else {
        fail(`POST /runs/:id/takeover → ${take.status}: ${body}`)
      }
    } else {
      takeoverActive = true
      ok('api-takeover', `runId=${runId}`)
    }
    if (takeoverActive) {
      const release = await fetch(`${apiUrl}/api/bot/runs/${runId}/takeover`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ takeover: false }),
      })
      if (!release.ok) fail(`POST /runs/:id/takeover release → ${release.status}: ${await release.text()}`)
      ok('api-takeover-release')
    }
  } else {
    console.warn('[bot-live-smoke] WARN: no runId within 30s — takeover stage skipped (worker may be down)')
    if (LIVE) fail('BOT_LIVE=1 requires a worker so computer tasks produce a runId for takeover')
  }

  // --- teach → skill library ---
  const teach = await fetch(`${apiUrl}/api/bot/tasks`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      goal: 'bot-live-smoke teach — demonstrate opening a terminal (frames only).',
      kind: 'teach',
      maxSteps: 4,
      computer: { enabled: true, ttlMinutes: 15 },
    }),
  })
  if (!teach.ok) fail(`POST /tasks (teach) → ${teach.status}: ${await teach.text()}`)
  const teachPayload = await teach.json()
  const teachId = teachPayload?.task?.id || teachPayload?.id
  ok('api-teach-enqueue', `taskId=${teachId}`)

  const skillsBefore = await fetch(`${apiUrl}/api/bot/skills`, { headers })
  if (!skillsBefore.ok) fail(`GET /skills → ${skillsBefore.status}`)
  const skillsJson = await skillsBefore.json()
  const skillCount = Array.isArray(skillsJson?.skills) ? skillsJson.skills.length : 0
  ok('api-skills-library', `count=${skillCount}`)
  console.log(
    '[bot-live-smoke] NOTE: teach is frame-only — noVNC cannot capture raw local input into the timeline; distill uses screen frames. Full skill_saved needs an operator demo + Release (not automated here).',
  )

  // --- pause/wake same box id via API ---
  const wake2 = await fetch(`${apiUrl}/api/bot/computer/wake`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ taskType: 'default' }),
  })
  if (!wake2.ok) fail(`second POST /computer/wake → ${wake2.status}`)
  const box2 = await wake2.json()
  if (box2.sandboxId !== box.sandboxId) {
    fail(`pause/wake same id failed: first=${box.sandboxId} second=${box2.sandboxId}`)
  }
  ok('api-wake-same-id', box2.sandboxId)
}

async function main() {
  if (process.argv.includes('--help')) {
    console.log(`Usage: node scripts/bot-live-smoke.mjs
  Default: skip (exit 0) when E2B_API_KEY is unset.
  BOT_LIVE=1: FAIL when E2B_API_KEY or E2B_DESKTOP_TEMPLATE unset; require API stages.
  With key: create → stream → pause/wake same id → kill.
  API: BOT_SMOKE_API_URL + BOT_SMOKE_TOKEN → wake, ws-token, files, computer task, takeover, teach, same-id wake.`)
    return
  }

  if (LIVE) {
    console.log('[bot-live-smoke] BOT_LIVE=1 — hard gate (no skip on missing key)')
  }

  const skipProvider = process.env.BOT_SMOKE_SKIP_PROVIDER === '1' || process.env.BOT_SMOKE_SKIP_PROVIDER === 'true'
  if (skipProvider) {
    console.log('[bot-live-smoke] provider stages skipped (BOT_SMOKE_SKIP_PROVIDER=1)')
  } else {
    await providerSmoke()
  }

  const apiUrl = (process.env.BOT_SMOKE_API_URL || '').replace(/\/$/, '')
  const token = process.env.BOT_SMOKE_TOKEN || ''
  if (apiUrl && token) {
    await apiSmoke(apiUrl, token)
  } else if (LIVE) {
    fail('BOT_LIVE=1 requires BOT_SMOKE_API_URL + BOT_SMOKE_TOKEN for wake/stream/task/takeover/teach/file stages')
  } else {
    console.log('[bot-live-smoke] API stages skipped (set BOT_SMOKE_API_URL + BOT_SMOKE_TOKEN to exercise wake/ws-token/files/chat)')
  }

  console.log('[bot-live-smoke] PASS')
}

main().catch((err) => fail(String(err?.message || err), err))
