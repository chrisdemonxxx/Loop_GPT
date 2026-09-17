// Test Docker's actual ignore semantics using disposable synthetic directories.
// Only the three ignore files are read from disk; no real source/credential files
// are copied. Uses the already-built local backend image and no RUN networking.
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

export function checkDockerContexts(project) {
  const cases = [
    {
      name: 'staging', ignore: './backend.Dockerfile.dockerignore',
      dockerfile: 'deploy/owned-staging/backend.Dockerfile',
      roots: ['backend/src', 'backend/prisma'],
      allowed: ['backend/src/envValidation.ts', 'backend/src/__tests__/fixtures/tinyVideoMp4.ts',
        'backend/src/config/credentials.test.ts', 'backend/prisma/schema.prisma', 'backend/prisma/migrations/fixture/migration.sql'],
    },
    {
      name: 'web', ignore: '../../web/.dockerignore', dockerfile: 'Dockerfile',
      roots: ['src', 'public', 'build'],
      allowed: ['src/security.ts', 'src/config/environment.ts', 'build/pwa.ts', 'public/icon.svg', 'public/nested/fixture.json'],
    },
    {
      name: 'backend', ignore: '../../backend/.dockerignore', dockerfile: 'Dockerfile',
      roots: ['src', 'prisma', 'scripts'],
      allowed: ['src/envValidation.ts', 'src/__tests__/fixtures/tinyVideoMp4.ts', 'src/config/credentials.test.ts',
        'prisma/schema.prisma', 'prisma/migrations/fixture/migration.sql', 'scripts/private-storage.mjs'],
    },
  ]
  for (const fixture of cases) {
    const ignore = readFileSync(new URL(fixture.ignore, import.meta.url), 'utf8')
    const denied = ['', ...fixture.roots.flatMap((root) => [root + '/', root + '/nested/'])]
      .flatMap((prefix) => ['.env', '.env.production', 'tunnel-creds.json'].map((name) => prefix + name))
    const assertion = `const fs=require('node:fs'),a=require('node:assert/strict');` +
      `for(const p of ${JSON.stringify(denied)})a.equal(fs.existsSync('/probe/'+p),false,'Sensitive fixture admitted: '+p);` +
      `for(const p of ${JSON.stringify(fixture.allowed)})a.equal(fs.existsSync('/probe/'+p),true,'Legitimate fixture excluded: '+p);`
    const entries = Object.fromEntries([...denied, ...fixture.allowed].map((path) => [path, 'synthetic nonsecret fixture\n']))
    const ignoreName = fixture.dockerfile === 'Dockerfile' ? '.dockerignore' : `${fixture.dockerfile}.dockerignore`
    entries[ignoreName] = ignore
    entries[fixture.dockerfile] = `FROM loop-owned-staging-backend:local\nCOPY . /probe\nRUN ${JSON.stringify(['node', '-e', assertion])}\n`
    const tag = `loop-owned-context-check:${project}-${fixture.name}`
    const parent = process.platform === 'win32' ? join(tmpdir(), 'opencode') : tmpdir()
    const context = mkdtempSync(join(parent, 'loop-owned-context-'))
    let built = false
    try {
      for (const [path, text] of Object.entries(entries)) {
        const destination = join(context, path)
        mkdirSync(dirname(destination), { recursive: true })
        writeFileSync(destination, text)
      }
      const result = spawnSync('docker', ['build', '--network', 'none', '--pull=false', '-t', tag, '-f', fixture.dockerfile, '.'], {
        cwd: context, encoding: 'utf8', timeout: 120000, maxBuffer: 4 * 1024 * 1024,
      })
      built = result.status === 0
      assert.equal(result.status, 0, `Synthetic ${fixture.name} context regression failed\n${result.stderr || ''}`)
      console.log(`PASS: ${fixture.name} Docker context excludes ${denied.length} sensitive names; retains ${fixture.allowed.length} code/assets/fixtures`)
    } finally {
      // A failed build creates no final tagged image. Successful test images are
      // removed by exact unique tag; build cache is intentionally retained.
      try {
        if (built) {
          const removed = spawnSync('docker', ['image', 'rm', tag], { encoding: 'utf8', timeout: 30000 })
          assert.equal(removed.status, 0, `Remove synthetic context image ${tag}`)
        }
      } finally { rmSync(context, { recursive: true, force: true }) }
    }
  }
}
