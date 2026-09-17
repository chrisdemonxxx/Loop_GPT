#!/usr/bin/env node
import { createRequire } from 'node:module'

const help = `Usage: node scripts/private-storage.mjs --help | --init | --check

Requires compiled backend, but no database, provider access, or .env loading.
Set PRIVATE_FILES_STORAGE_MODE=shared-filesystem, PRIVATE_FILES_DIR to an
existing absolute canonical directory, and PRIVATE_FILES_STORE_ID to a canonical
lowercase RFC UUID. PRIVATE_FILES_MIN_FREE_BYTES is a nonnegative safe integer
(default 67108864 bytes / 64 MiB). No production local-directory fallback.

  --help   Print this help without configuration or compiled backend
  --init   Explicitly identify an existing EMPTY directory with a version-1
           .loop-private-store.json marker. Matching markers are idempotent.
           Stop writers during initialization. Never overwrites existing data.
  --check  Verify namespace and headroom; create/read/fsync/remove a random
           private canary, plus directory fsync on Linux. Does not initialize.

Shared-filesystem is an operator attestation, not proof of replicas, backups,
or physical durability. Headroom is a statfs snapshot, not a global quota;
concurrent writers can race. App/worker never auto-initialize a namespace.
Exit: 0 success, 1 unavailable/configuration failure, 2 invalid arguments.`

const args = process.argv.slice(2)
if (args.length === 1 && args[0] === '--help') console.log(help)
else if (args.length !== 1 || !['--init', '--check'].includes(args[0])) {
  console.error('Invalid private storage arguments. Use --help.')
  process.exitCode = 2
} else {
  try {
    const service = createRequire(import.meta.url)('../dist/services/privateStorage.js')
    // The operator CLI always requires the explicit production-style contract.
    const env = { ...process.env, NODE_ENV: 'production' }
    if (args[0] === '--init') await service.initializePrivateStorage(env)
    else await service.checkPrivateStorageReadiness(0, env)
    console.log(args[0] === '--init' ? 'Private storage namespace initialized.' : 'Private storage readiness check passed.')
  } catch {
    console.error('Private file storage is temporarily unavailable. Check configuration, namespace, permissions, and free space.')
    process.exitCode = 1
  }
}
